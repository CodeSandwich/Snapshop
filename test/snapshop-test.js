const { expect } = require("chai");
const geth = require("geth");
const { ethers } = require("hardhat");
const {
  createBlockSnapshot,
  createAccountSnapshot,
  getBlockHeader,
  getProof,
  sloadFromSnapshot,
  formatBlockHeader,
  mapSlot,
  fixedField,
  fixedString,
} = require("../src/snapshop.js");

function dynamicField(value) {
  return ethers.utils.arrayify(value, { hexPad: "left" });
}

describe("Snapshop", function () {
  let snapshop;
  let erc20;
  let gov;
  let signerAddr;
  const dummyAddr = fixedString(123456687137684, 20);
  const totalSupplySlot = 0;
  const balanceOfSlot = 1;
  const allowanceSlot = 2;

  before(async function () {
    const options = {
      dev: null,
      http: null,
    };
    geth.start(options, function (err, proc) {
      if (err) return console.error(err);
    });
    // Wait for geth to warm up
    await new Promise((resolve) => setTimeout(resolve, 500));
  });

  beforeEach(async function () {
    const Snapshop = await ethers.getContractFactory("Snapshop");
    snapshop = await Snapshop.deploy();
    await snapshop.deployed();

    const ERC20 = await ethers.getContractFactory("TestERC20");
    erc20 = await ERC20.deploy();
    await erc20.deployed();

    const Gov = await ethers.getContractFactory("TestGov");
    gov = await Gov.deploy(erc20.address, 10);
    await gov.deployed();

    signerAddr = await erc20.signer.getAddress();
  });

  it("Creates a snapshot of a slot in a nonexistent account", async function () {
    const blockNumber = await snapshop.provider.getBlockNumber();
    await createBlockSnapshot(snapshop, blockNumber);
    await createAccountSnapshot(snapshop, blockNumber, dummyAddr);
    await assertSloadFromSnapshot(snapshop, blockNumber, dummyAddr, 0, 0);
  });

  it("Creates a snapshot of a slot in an empty account", async function () {
    const blockNumber = await snapshop.provider.getBlockNumber();
    await createBlockSnapshot(snapshop, blockNumber);
    await createAccountSnapshot(snapshop, blockNumber, erc20.address);
    await assertSloadFromSnapshot(snapshop, blockNumber, erc20.address, totalSupplySlot, 0);
  });

  it("Creates a snapshot of the only slot in an account", async function () {
    await erc20.approve(dummyAddr, 123);
    const blockNumber = await snapshop.provider.getBlockNumber();
    // The allowance has changed
    await erc20.approve(dummyAddr, 456);
    await createBlockSnapshot(snapshop, blockNumber);
    await createAccountSnapshot(snapshop, blockNumber, erc20.address);
    const slot = mapSlot(mapSlot(allowanceSlot, signerAddr), signerAddr);
    await assertSloadFromSnapshot(snapshop, blockNumber, erc20.address, slot, 0);
  });

  // Results:
  // Gas used for createBlockSnapshot: 58621
  // Gas used for createAccountSnapshot: 103965
  // Gas used for sloadFromSnapshot: 34113
  // Results after subtracting `Snapshot.sol` overhead which is
  // caching the results in storage (22K for a fresh sstore)
  // and loading the results from storage (2K for a fresh sload):
  // Gas used for createBlockSnapshot: ~37K
  // Gas used for createAccountSnapshot: ~80K
  // Gas used for sloadFromSnapshot: ~10K
  it.skip("Benchmarks creating a snapshot of the only slot in an account", async function () {
    await erc20.approve(dummyAddr, 123);
    const blockNumber = await snapshop.provider.getBlockNumber();
    // The allowance has changed
    await erc20.approve(dummyAddr, 456);
    const blockReceipt = await createBlockSnapshot(snapshop, blockNumber);
    await printGasUsed(blockReceipt, "createBlockSnapshot");
    const accountReceipt = await createAccountSnapshot(snapshop, blockNumber, erc20.address);
    await printGasUsed(accountReceipt, "createAccountSnapshot");
    const slot = mapSlot(mapSlot(allowanceSlot, signerAddr), signerAddr);
    const sloadReceipt = await assertSloadFromSnapshot(
      snapshop,
      blockNumber,
      erc20.address,
      slot,
      0
    );
    await printGasUsed(sloadReceipt, "sloadFromSnapshot");
  });

  it("Creates a snapshot of a slot in an account with only one slot", async function () {
    await erc20.approve(dummyAddr, 123);
    const blockNumber = await snapshop.provider.getBlockNumber();
    await createBlockSnapshot(snapshop, blockNumber);
    await createAccountSnapshot(snapshop, blockNumber, erc20.address);
    const slot = mapSlot(mapSlot(allowanceSlot, signerAddr), dummyAddr);
    await assertSloadFromSnapshot(snapshop, blockNumber, erc20.address, slot, 123);
  });

  it("Creates a snapshot of a slot in an account", async function () {
    await erc20.mint(dummyAddr, 123);
    const blockNumber = await snapshop.provider.getBlockNumber();
    // The balance has changed
    await erc20.mint(dummyAddr, 456);
    await createBlockSnapshot(snapshop, blockNumber);
    await createAccountSnapshot(snapshop, blockNumber, erc20.address);
    const slot = mapSlot(balanceOfSlot, dummyAddr);
    await assertSloadFromSnapshot(snapshop, blockNumber, erc20.address, slot, 123);
  });

  it("Casts a vote in test governance", async function () {
    await erc20.mint(signerAddr, 123);

    const blockNumber = await gov.provider.getBlockNumber();
    const blockHeader = await getBlockHeader(gov.provider, blockNumber);
    const proofCreate = await getProof(gov.provider, blockNumber, erc20.address);
    await gov.createProposal(blockHeader, proofCreate.accountProof);

    const slot = mapSlot(balanceOfSlot, signerAddr);
    const proofCast = await getProof(gov.provider, blockNumber, erc20.address, [slot]);
    await gov.castVote(0, true, proofCast.storageProof[0].proof);

    const proposal = await gov.proposals(0);
    expect(proposal.votesFor).to.equal(123);
  });

  // Warning:
  // This test fails unless `SnapshopLib.sol` is modified so function `blockStateRoot`
  // doesn't verify the on-chain `blockhash`, a change of `==` to `!=` is enough.
  // This requirement can be lifted by migrating from Geth node to Ganache and its mainnet snapshots
  // after it adds support for `eth_getProof`: https://github.com/trufflesuite/ganache/issues/382.
  //
  // This test works on the real world Tether state on mainnet.
  // It reads the balance of the Tether treasury for a specific block.
  // This allows benchmarking against long, real world proofs,
  // mainnet has lots of accounts and the Tether contract holds states of over 4.5 million users.
  //
  // Results:
  // Gas used for createBlockSnapshot: 61193
  // Gas used for createAccountSnapshot: 186595
  // Gas used for sloadFromSnapshot: 178788
  // Results after subtracting `Snapshot.sol` overhead which is
  // caching the results in storage (22K for a fresh sstore)
  // and loading the results from storage (2K for a fresh sload):
  // Gas used for createBlockSnapshot: ~39K
  // Gas used for createAccountSnapshot: ~163K
  // Gas used for sloadFromSnapshot: ~155K
  it.skip("Benchmarks a mainnet USDT contract snapshot", async function () {
    // Response from: curl https://mainnet.infura.io/v3/<infura_key> -X POST -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
    const blockNumber = "0xe386ee";
    // Response from: curl https://mainnet.infura.io/v3/<infura_key> -X POST -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"eth_getBlockByNumber","params":["<blockNumber>", false],"id":1}'
    const blockResponse = {
      baseFeePerGas: "0xdcf23e72c",
      difficulty: "0x34442c862ca0e2",
      extraData: "0x75732d77657374312d33",
      gasLimit: "0x1c7881b",
      gasUsed: "0x5ef957",
      hash: "0x15caa2dc76e7f3a0869f85f1c0a00ecb2963869de6df2c589aff891cb8a7d43e",
      logsBloom:
        "0x0c2001a240020a0408c02050a912014610230c8c48900400800c560a560605002002010820005a600600420242110540421140604a0831850801090a117774a04084180010508068c8842358851928a206a2600024461b100c0421239800820f1b688d02120060000821009020a01880207a001052888c58610011101208200a80000380912011a0150a044008425470c45018014100040c02209849401f00612221d43508936c882ca141a105898d000804400081e0802010720c2c1c01d92561108d4224a5008110025d30810a400201020268882a401488202187121960b62017202c0e104004000019c4018c898240002040298820602842c8820312a203",
      miner: "0xea674fdde714fd979de3edf0f56aa9716b898ec8",
      mixHash: "0xe816794332ea7aa48bd08d4f8d7ef5bb2bc8a8a7751bcccdaa5eef48e25f888f",
      nonce: "0x154810cd7b4ebc3e",
      number: "0xe386ee",
      parentHash: "0xa2fa4e47bcb6111035cb5978d88e5853580d98d555680989c858eaff604d2cbe",
      receiptsRoot: "0xf5b0a8a6ab342df54d0afb0120975b8c7733178680722d1b1f8310c4319cfeba",
      sha3Uncles: "0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347",
      size: "0xa80d",
      stateRoot: "0x43ecf652ceb1192010e7d1dfa523eafe6ea21c511a1573e4f76b42a872d248e1",
      timestamp: "0x629d1c74",
      totalDifficulty: "0xac9299969af72d6e26c",
      transactions: [
        "0xdd4c292ae72d774d99b8c880abcb9d3e12dc9d7f1e5e80b432672cbfef16120c",
        "0x919eb2ce10fb67765c9789baec4801fae6085a3d1b58ed1f43ec40746e2b9e34",
        "0x9980b3a724f3e9a1696f26a16db625c94e8f074acd68a68e8ca379f4e7ad34c9",
        "0xa2e98b3e022c54b8c9efd7a7ce8267c4dddf586e73bc40317eaf44617fe293e9",
        "0x505228a87f442ed46e5307cff99476069c8387aeb2fc4c99cf78c3073162b82d",
        "0xee679d60f687e13020aff90e42aba9025736089843b98c259d643dc788ceafaf",
        "0x561d76ddc8c1ba6b98532c016234f3f64f7158ec29f36273eea427cfa0d6ce31",
        "0x36ef43342f9cbde68c94cd298c68bf4a773b5182f6f481843be78d32c979ad75",
        "0x649e2bb32bc350aedbcdd2da2c242f8cff90dffe135a475f050cf4b15e52ae34",
        "0xa35a8354671ea0a4be2e96603ab932b307498356707221df7b1d692e213fbb20",
        "0xec771879e64ac96f6e5afc9b11d2bc4fb4d4889201faffdd70be56e3e39040c6",
        "0xabea5778f8bdc7a04bc86198770796e6235ad734f89c9b2e2720a5e7283c0870",
        "0xca2fdbe191f9abe09b1a96fac85753494fcca831bda0effaa366a5c79885b64e",
        "0xb09c71810e2007953d1ea9efd44644aff8ac15c87c652824a9783b705e98082f",
        "0xa3c8832c80da368598cd64f42ba0f9a0b8e28d45171f12df9759fe5ddc3f0636",
        "0x9bb9a46c4f6bd64010e32c6e48f617f68111b70f92fd59604a758a6c5946a0a0",
        "0x5b0d58e512e5c3fc7328a051e50c0235febad9a8af503ee34aadc1fa3e20eee3",
        "0x85706ddb89c62e805e8de8cf7ed605bd092f3979a9093592bb92908c2f157a4f",
        "0x10501f2bac7ebc762089c453e3e1a5f9f061c210cb68cc88ff1a26b0c1010910",
        "0xcc2dc81ff1a50147cf65be9b5543fe43ddd32ba287cb3be52db0b348078c72bd",
        "0x908d9091bf70f19648983d3c7a8c776eb0f1e7792d3addce74be8811e69f1650",
        "0xebd46ce1485aa9b80dd0d36d9dda7362af1ad5855b2cbe21072b8892e9eac9ab",
        "0xe8573c9ac520df1a2aaaa6efd41061742911737b403bf8d5267baf616e9b1079",
        "0xa01eaa87419a1ca290e1410d3a5b767bc887a0b788b3826efc396e5662c62300",
        "0xc1f60b524b1c7253e6dcc70fba7b3c966509b6832ad628b7249d40efd2a85af5",
        "0x19edb84d2356c748e891af208b14267dd900588cfe25545620396c4e42cbddc6",
        "0xc445fc23ba637ea0343d14d612aff458f35d6ecc35f69ab94dbabf2a04fd529f",
        "0xa264b1c184788f009bd619d6c54fdce54eb447074e567faa8fc5dc58f576f52a",
        "0x72c49eeef27819fcdb9512b5884ca54e695400e4ff4f9695c2de35fc5135ac27",
        "0x533ae3e9b5e40b279db855a05be1d7d9992aa00defea9d5944004c15984f9583",
        "0xb3b6470131fbd292c596004c6a58545142dbf8cad512b4c0a2aedeae70744479",
        "0xddceedea2722b93aef532edb8e7b499e6a08b468a8f7f9130fbd463741446285",
        "0x12af26cc8bd6a7ec8c692371fd3945ddc9ae081306d7c0dc42fc0bb498148f62",
        "0x3ff27fdfb999cd49894c8fc0eba2260e98d4b7494d322b2bbe6d2458420ae96a",
        "0x465384e3393d2c97cdc169f82c368da3a42d38032adb5cc09fbd6eec8a7e4b6b",
        "0xdb696b8fe34981a8fc40edc2ea93d99170340b22dc1e413be3d7a80aa8199254",
        "0x2da1469238cf79cf4a7c5f84a48f3e060b34bbd8863a87828c7f2d562b1dffc2",
        "0x81aea1e62463fa3940ebb03ff1371d75ca22b0a6469be686ea3ad00e65456338",
        "0x9f8be157ae2bd0ff1749bd6dbdedbb05b1e96f2184eda09a2802b01d4acf5b4d",
        "0x5f2f62abe77c42c715f5c3beae7ca4eadbf411297d46e0485c5dec7bd94fd2bd",
        "0xf41bdbb9da82a94a22067d53ad618082210de48780ca9b883e4060390953845f",
        "0xac8dff376f2011dfb4b654083712ea9aae6ebfe2876ce23b5d4befb8d6e454fa",
        "0x1d286c520beb26cbf251f8f947acd4c5a4245bf77ecd23adbb43b5c58de72ef1",
        "0xdda278923cc064317b966af920325e39719d13faafd615ce161256345586a64f",
        "0xf35b933febcb933235a16dc4f447a90fa72bfdc03fc175905a6f40a24643af16",
        "0x88bfe1778fcea6bd710d49c82dc5b0c7c840c9d4c017b8c52bd10301e3084aec",
        "0xbfbfc2e313b97d84e553d64b4a69f580f4a5726a4ee3f35f670bc634552403aa",
        "0xe64afee3acb78d4f7ee47dbc1ece42f75b51fa1e003dcb7d7ae683a82d345832",
        "0xa8392ee830031875b5f7a15130372e9248a142741c9f78e308b57fb753115c9f",
        "0xcab6023532bf14d67b153057f7a49b0fd0bfd96e5f4d2d1071e4439f9f8cac03",
        "0xef06761d413eac38b2f58339334ea5bf5921748b20409c1a51a1e8fe45fd625a",
        "0x8fd70072087772901e2fa64b431b0ee7d20f64dab9158131a0b5fb671d3f5f5e",
        "0x2c4c5949d6d815356165d5b2d8fb1b50a3f86b9c29f958a4f80b275fdea35e2e",
        "0xac1e287f66197ce0ec5e6ac14c9208625100941600ff1e2bc936adc966581036",
        "0xf385feba78e4cb96c996fa1fc27b4a8082d8ec92beb0cd88537b3f43ced456a5",
        "0xa18001f92823749217f160e18908ff22ab6210c92cbcc51d6cca3dc36452612c",
        "0x46ea7453c0adff3f5185c950602c2f1900b8c281096d193347d183545ff6f3e7",
        "0x31505f66d44e90b8c642a85e7b6bc083ed63d4cdf76a8fc6748b11f85d4dab2d",
        "0xa78ae6f760f8baf379de675fc40699be85966a15716860f453fe7243228e5688",
        "0x23cc1aa6775c7ac63b0e9583f721a09ac25330ab497befd441ddf8f2fc3fe292",
        "0x395a0846a7dd9aa47403cf982e1699e58d09c75661b9c417c2346f9a54bb5014",
        "0xa9e9f815b69d8034765813910a9ec7fb80c73e89f3de53e2a1f70ade86a6b547",
        "0x6c2339149d128157860f0e07b590d2b45ec9fd2cacca19ecc241b43564fbbaac",
        "0x9cba6d6715be60b99790f9d3a2cb53a3fde873edc4492c45faef6909870efeda",
        "0x746a8aa8b9356b38dd6fc10ad536798c3fa918e1b006593b1f49edf6f416b415",
        "0xb18d130a5b9e794f52ceecde70feef51421c7f29ee6630e74bb694d74158ae2e",
        "0x1dfff3464eb2551d2a42badc493d16b5e05942a3ad1c60dc188781c9464e0049",
        "0xfc43f2f107108773733b7ee6b5224a81d75e501373eec07e3258a6b977dcde75",
        "0x805deaff34bba23bd20569a40c400daa180c8b38d1a3a9b05a7a6594010768eb",
        "0x86bacb84b5cb5378440b1089c5445c0aad6bbffc06a0f5534ae06d4d8a9eeb2c",
        "0x972c555aad402fc2c7f0028fc709acfd14552b53de79edef724bcc846ef55a46",
        "0x04d6c3d27e65ca729e60cfeb7cb207071c0a8b3d23c4cb76e6a483cc9c87208c",
        "0x2abca0fcb06bed60aa87d989ebc7030c9a54830d90462d21cb824b321f36c5e1",
        "0x0f05a1a42932362bc0472898646c09b7da4cc32d1ca9f50d4b267cc97789d9c6",
        "0xef87e36a7f5f65d0d6836a05228a35d6e6b0209b8f7b39c0eb52d264da83a879",
        "0xf74e720da4fb21d9a1eeb61bb66b02f267eeb1d1fcb6a9c17bca55c42fc412e5",
        "0x8e673173f8daab841e26209f00ccbb5e3b27f578eaed45616be7f070adfe7d77",
        "0xeb789348a8839140756b2b8b2e0753dd56d66448cae15546cc9ca250f4dfe1a1",
        "0xd434334c4a4721dfbe0e320ddca66e8a039b6cbf2b0312aa70051edbcd6f91d0",
        "0x01f67ba709217e5005dcf07c726ca6c2ae6737852f66a92707ffa018086c4af9",
        "0x014574bd1a14606ef1eb204d18990f9b694d0467745fdfce1f331c62fe7d021b",
        "0x7fad604a941c7173698dce6251823f8f8ee8e27297b703c1eb3fe2ef2cdf8279",
        "0xbdbe1539e2c367503deadf017bc368e6874d43dc2b718efdbb3d466268c06d3d",
        "0x81bb8e80606298cfffe5a33d0b2ea81ed0bc4ae7f24780828bd95ea4ffc6cd95",
      ],
      transactionsRoot: "0xd2677f596957c92985246ee4265f8dc862693e1963760eb0575453ab534b8941",
      uncles: [],
    };
    const blockHeader = formatBlockHeader(blockResponse);

    const blockReceipt = await snapshop.createBlockSnapshot(blockHeader);
    await printGasUsed(blockReceipt, "createBlockSnapshot");

    const tetherAddr = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
    const holderAddr = "0x5754284f345afc66a98fbb0a0afe71e0f007b949"; // The Tether treasury
    const storageSlot = mapSlot(2, holderAddr); // Balances mapping is rooted in slot 2
    // Response from: curl https://mainnet.infura.io/v3/<infura_key> -X POST -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"eth_getProof","params":[<tetherAddr>, [<storageSlot>], <blockNumber>],"id":1}'
    const proofResponse = {
      accountProof: [
        "0xf90211a08b0fbf416959f1b0320e6ecb2d8b63f08fc68e6451dbd393dae3e87c76df753aa06b817afa39f9707f7965defc2fabd06711db79ae8d534c9a7aa9e0949f5b25daa0af3ceda1d10ab73e3acc977ed1161033b74a2b13bc786da273cfc4bbaf423b09a040b8db6b9f56129a4f48062791f1c24c34160c64442cae0d175f5fc635b14524a0f6ce88589eefe5461ac95d02abae5d8453249ab6916af824dc7fef6497bf12a3a001f82db70ae963f2a0ca2497e2eb4dbae3f30d6ad8318b0465d079e80b24af85a0e9deaa69c20cd7d21c00b335752d895b5d6b7ec10c66023ad8733b87c1f5c069a0379a07b19974473bbca9e8d64a724a73f1acdcc1f240aa2830f90e1f48e560bca0c231e2766188ec28a8bd76e93f2df7a019a401b3c46f15cd65a3c8fa8b8fa91aa00879d0f4494c4e15c3fc38bc16884cc405f5632c8a359c35d1244b8bcbe11fa9a0387aaab3e38a5a9e988d6d2ac7dcd9e0cf2f732b06cf1dda3377f1c1a9e971fea068ef45bb0a99ae50f9037da8af07bfc1b807bfb6ef6f8ed02bcdeb478fb31b9ca002428a6b0081e2e1fe967b3ba3d23dce8e9b691e14869194c4d456fa4b60d759a0749749c882767ee063a92385dfe6e5cf901aca04ff0150b225fa09ff5b0b31dca06554060119dc2764249ed788667b9fa2f5efd373d6c192d706dbd81f86795462a08c3039bd2e5f90470cb366f202dbf53ea9c899a608a168a302d7cb992b9a655880",
        "0xf90211a028f3cccf87462226fe42a7d1544717b14a012cef4c6362e2638b9bd1f054f9a4a0b45aac0fb9b3dba3c3a52068bf5439299c66ce59310e43565b7cb32125f54bcfa07e7664be5d0970841961b59951b6d088ec3ec154a6a356f46671db09ee5bf2baa029a6501c43daa32e7d8386cb2d8b3577af92c27d4a65bc472e94e4edef4e4184a0590b0a9b0027015454a52b9ea90260859735e1d86efa25371979db8df2d43251a0add5992a8b24e067e0779f8d348f1d40560d9ece62fef92572597e2520322e60a0fb8468bfef77c0833e0a9ab85c4db8b0a3d3b7e1ad0b351ed52a38e3da80822ea0e9906e3c222cadb317e9852901bc6b12c1d800306165b0d50aad8fa16144eb03a0cbbb1498c515156931bd9cf4cb169bab7c79d0ec7155eb8d6ce6590bf14491dda05e9dd5d2920b813003175ef7602ae969d002b6ec424cb9340905eed67b92a52ba0245b9bc5e54e1979b80f9542f147ae90dc2ae1ced94295f0f99a58ce47cf553ea0d16c72c630ec6c5117c93b0f7b63fbc0f2a2a42d9349ce4b213218d37ce2c363a0908a1cecbcbb40cc523c5a35f1cd5f66718c219ba6a70300f1a31cdff5ded5e9a0dc9a0fb7bc9f73bab5f6f1eee3851a92a42c055c15a15a72395f90b3eb94a8a5a05d794f126c075cd36563eb45660371d67261da3ddb38c7cf6e6fc4e7a147e7e5a0e41854bf6af57d80b5fd03023d6709e0952eea8ff22dfc4977313bd4daaf77aa80",
        "0xf90211a069b1e4e9258c30c202fbac2e65c2abab24786468b9cb7151b9e32e32de49b729a05ac34af1af4e04cc7064588fb18bc2ab66d04dbdfe882870f7589f5470fcaa8aa0ec430320ac8c196aef5b0706577fbc56f0c3482e1fc89ac1bd18e5902fe93d9ca03d1ff7f42b5bf2c4dd901a9f9f0491a5d7f01bacb333489b036880c9b1fc5d2fa0e55f627c9fbcf5e9e1f12682d37e0b9f097d775e92571157e19f6724b45c1e0ba0fd51c50be2f3b05d5a2b93c1e4a7a4c36419ef53d5ef7dfa52a390b7161d7979a00ea751bebd3686d485061be16526825fae8bb00bfe2d243319267ca18abea0b7a0bff3240036ccdc76e58c7f06478bed743f30fe7c4e5eaeca866514ff0883da5ea082239cab2202ddbfcbfa18deaf72be48371f346658bc1bb9b489f2744131c90fa0633164611115fc1c75c8cc810db189286cb19af0003c9402b767306521030013a0153805926dcfe253e5b512209964560aa950e496294ea144b145b56877ed4c7da02a18a668409eedd7bb21dd2c21769650fc19f208592998b43cdec658334ae4c4a083b1546c3d1f4f14a0b077ef00c6af1fa7c44831281a897723f2c698faa6f570a021a780dc9006473baf9b36376152181628710c5c74152a90ba413e38557dbaf0a037f6d51006a74b73baa628cacaf8f135144052ee5b5d06a110235c27c798b2f6a05137f47d9014fe91a4fcccda6e7a0edbdc62c81947ca2d06b366da4c43e6e56380",
        "0xf90211a0315092d2a7f556878063c142cd3b6ac0d3198a94eaf11d5dc490d45da652db65a034bc49f77e55f2f761503f81d6df3891ef7335e58d6c0cb4933f7fe032d672e0a0a47b9da5ab42469a681784f256da761cdd3ef30986a45313ab26ce8489cceca0a0ce77413487a30f636c1a4e9f5942978054292540bf163c31dd4629e53a751ecda0924e55795a4ac6688b798f084cc1f13025da0eca75e21a979ab189ae006eb068a0b52dc6071104b9a307f60ef7d995c2d37ff0ad5c6b264741bb35312e4a1bed4ca0aee6603f0295632b4ddf80c7e7e216ebe77b104f08ee8b503171358b63e337e4a022f5f3f8f8d073767ff2b40715baeb14a7d6c4e48d72753d81c68b6137067bc2a0afea187d0c318509caff21db7a1d837bd3bc944c8ac99992d8d6bc161d2a8458a0e7368707c81e7f8021a96f3e2f11fd8bfa5768cc266a656daeec9622aab14246a0436a6f282f9c68fa2a18b57adf5ef560deea73dc0f2c11f47cc60e1429cd8d0ca06fe9921834c885db150fa68326b20ea6650f995e214bf2d09dbc5d68e44ce290a04930692521a1c68379ec905af1f8c8139d03fe46e38a2b8c7b7ce2b609d1af51a0c0455f826573b3e512042293b8bb2705bb7fe0a55c1ebaf4ff91548db016258ea0afeafa42df8b24d1493a030a1afe1359cd2ed589b790acd54c782079d908df5fa074fa42a99cb37f5fe3e99b06137b9a803d94eda47c1666d3c68e555bda43b73c80",
        "0xf90211a03b9bac5c1ff4905c24bec2b12c69654386ef54e93c77bde20e433c2fb9ec3965a00fabbff7c78c71984914d22cd17e85239b73fdd163ab94834f06ebb43ca27ee7a0874ff079334f54dfdf2f3c5e338c93df825fd2fb8c218e159d198ba31f3f08e4a0f018c45ac8c42a8f0bda10651aa12d1ea885e59ff89c84346cb937e841806f92a0ad51685ec96f3bae3cdff1521f1fc512201a6dd97e21478e5aeb5f8c547913e8a03eae536abe3a9df0c16a840c86cf937b95dac370e1f0b4778b82751a9beba963a072e8c1cb6d5e9bec8c56130eb9df9f93d663c6e6e3f19c7ce4c89a52eec11258a04036ab03319d8dad3601570febfe565bda2cecc82ba7ed8d77a14a919a6230e2a02f90d3220649008a1d691dd44195212e77df021345788123e9ecdc6d28a60c8aa07e70dd99382afc446ff7f057e0228ac7d61c5064c0b457d45298a83520c599faa0f4ed9abc564023e3adcbe1a58993d62685cb6fc5f7ef84f7d7d7baee3d3cec80a0e94a533753b7597583733f3d4df6d63f9d01d583247154ab0a8ade4c727edf1ca046e42394c30b257a20622e2eb110e3326c912103d7bb71fefd118a27938beeb5a0ca229c982c4947ddf5d671a385c5334ae59bf6347f397ab4a8fb906f7b66a324a04db8cee74fa3e319c11b982ab2b0656a6fcfc604b570a764aa3bdeb273ba6dc6a0cf29a9fe19805e0ba15902ea4f55f9532cbd728cbe606c383c455dc085541a3380",
        "0xf90211a0baf30c3cc186c07c7f9899dcd191630c228577f03da5d7ed31127c353b2f9c5da0f52a7ff44834798a137ef248ff810dd9a367763f7086447b9028396f4b3d0c6aa05344aa1c9ca2e3e56bf98fd718ec43728578d148e1967fbaf8bf17a2a073a0bda000c6c6bc5fed69a422b02bb6b18bf931b40f95c314844ccc84adcb4f62e137a8a0e73a35805c1f799f424302c35ba3ff73d828a6e1edefeed1833e3ca780ba2e7ea099b2ed07ae1e28ed0374ede4509f7b718541030f86cdcedd332d0e6ede28a731a036f86746d14954b6ee9c0020d3cb64061d5510fad894a4023b620e2227a943a0a0140e9d590e6d8ab525dba8164995514d4237b99ad7ffa4992eee82457a302b8ca0c4ce61346e69519e302c4c2530fea878f6addbf877464fd15235b6344141ecbda0cde35c201b005eb45c6f1529d9d3e515ffdd1a61b87e1c7c895beddcc454e104a08bf3eb0662e2cfaeeb9e736b3deff2e98dadf9bb34f60b429a8e80e6d1c2d1b6a0b7d528fc41c8fdc8ea18c6e7d0099270c777ec1403cf879d1f5134bdc12a6c6ca076e598b72d37771357048a358d63d51d7fab686e4a1cdcf9af316b31549f7a72a0d96c47e3457b518f701ccf3c672cf25062665273fcf03ee35c6aa1e2917a4f41a0b960a01d0268b02a076e7b5a9f3101f0a7d25d44ad0d597cf2ae98b44e929581a0ccb580ba9216573f40499a990e78250a0855637a6c1b9d48aa017e4795b58eb880",
        "0xf90111a01e7af2031302c134bbb3a6778c8cf033caa30300730c2f72e404cc7364cfec7780a09d1fde7ccd25f8c5a45399cd0bf2bc90006fd468f1a4cffa95a5a4eae7872b84a00b3a26a05b5494fb3ff6f0b3897688a5581066b20b07ebab9252d169d928717f80a01e2a1ed3d1572b872bbf09ee44d2ed737da31f01de3c0f4b4e1f0467400664618080a002b698a951faf4958a4804b060bfa4379ef74c4c3c096bec3efbb7a7e2597d97a07aad8ea34d91339abdfdc55b0d5e0aa4fc3c506f56fd2518b6f8c7c5d2ed254880a0e9864fdfaf3693b2602f56cd938ccd494b8634b1f91800ef02203a3609ca4c21a0c69d174ad6b6e58b0bd05914352839ec60915cd066dd2bee2a48016139687f2180808080",
        "0xf8669d3802a763f7db875346d03fbf86f137de55814b191c069e721f47474733b846f8440101a0124cb7ab6c0210080d0c0de9b20f57a6d94703e8dec95fe2c58479c1bf9d1bb4a0b44fb4e949d0f78f87f79ee46428f23a2a5713ce6fc6e0beb3dda78c2ac1ea55",
      ],
      address: "0xdac17f958d2ee523a2206206994597c13d831ec7",
      balance: "0x1",
      codeHash: "0xb44fb4e949d0f78f87f79ee46428f23a2a5713ce6fc6e0beb3dda78c2ac1ea55",
      nonce: "0x1",
      storageHash: "0x124cb7ab6c0210080d0c0de9b20f57a6d94703e8dec95fe2c58479c1bf9d1bb4",
      storageProof: [
        {
          key: "0x1443dce88f8c7f4f31845046f516109d2f1bbf5d692b3ae975bff8784725ce24",
          proof: [
            "0xf90211a002aa763c7ac631be1ca490c9c6d497967e8fd69b1d3881cbca1e94a40755c5f5a033f82ac5cc33af9001b2da6bb83c2315cfa12b16fca3338300fe3e348c2395e4a00a4209a660c2ee2b88e99ac76f80100498ebd632e260112c06b67bd8db9553d3a0c43579b565987b636f3530d5e5dc9e3f57ac12835364f021f6a29343ffb83aada0f202a261f5dbfe96d15d14578e8947413ecb36ed8b6e21709207bfee9d899c8ea06a885e11a03e3de7065903b340f7f2b58863e9db407d72fab6f8e3bae7db028aa0064ba1398f362d4bd16a3fc01fc584313b4386b8166f6757530669bf94880d6aa00ab0113c00e76a882c8ed3f2031000280d2813b4a2b77f268aab8e48cfe2a060a02596e95cb76ab473b6cf2a5e0e14fa41ffe26f5e8a211709370860f8299f6c1aa021c0707963412bb5f88d0a86b41fa3e239a640a4c79047799ce86d7a7770de22a02ef85ef91740d491e0d820ad604ea6c9591fb46e1be49554422ae95fb170a34ba0f39341cfc2deded1e6e919c7e9ba1772c2246c42665557044b8dc2bba3172325a0f66b2f5e4f8b355f7f73604e1f09514dfb96a44a39ee764072ac4ecc6372d2d6a013ec7f182bdb73e5a8f6813435de8a211e23cb59d382d8bdd85b646276446c3ba03b8d7040e7feeac364e69badef4b42b29c9baae2da7980ffcd9176fd6a4a5fa3a04e254ceea21cca4a965887da7edda98f4ebd762ec41ecd8e5c9813ca8433a0ca80",
            "0xf90211a086c4d9981b895f4e2794aa5ee8f858a5070305ef1d9371d5dfa6ea2f4ec59a5da0b192bc839c0db7a99fb0f3d1566e41900df76fb837567c71a805f429c890a04ca03d7026454e60a26b9413e0e800f9aa7afbc86a4a6fd4bfe8eaf3f54960b4363ca0a2b117553183d71582a90f7e4b8cfd915640b32b306d29f665bba837a5d55970a00c7001ba757bf19e0c0e2211b09517ffcd0d79e3e17316e162564369074529eaa0c70035641a54c93045233865cc601fe3cbc93a63902ac38c4e76b15041fcb50ba059d4ff27f85256ac07e4cdc52dff2c9ec8decaf40094793cc1f92469ce1647b9a00f7b87b833982165ce1d502a9476edb95fb2659f663fca78eb10781f4ff05b01a0c950c3b0f946604941f2172f592dc64c392335a1fe0c776186587f8d107b3421a02fb64a3426087b19b5324951cac493389d7a0080f27e379790199f9f366d2794a0a380f342fc84c93dcdc974afc76bb08f6658fa7ac7df3982106d1aa9176b7110a0862510777ff1be71367cf8724849619fc52f9d21080397f6441cda25fa5aa79fa07bef96a5b4b9bc85d56b08609c395c41fb83545f270fdde10054965b21f3877ea07e3b58e04b5d38b606684e94e8dd8db954c25a79f8fd50428c648b7527e5f3c6a014177be37d236e9d061302eeb6984a085681a5f65ebfe5b1eaa55b9f42cfd558a0df2636d5e2558fc253788b2124ec00673ec094a4bf191e396750092396c3b0fe80",
            "0xf90211a0f2927cb8e774f6dd5e8bcbbcfd0abae2a06c31a1cfdaa442d46ee5b46adebd13a09430342f9049abd936a5a6359667ff2ec2a53828b99b24f8f9214bd8ddaf63d2a0c446df3924964ce00289af23b03e69191dabc9ccd40d4c9e782bce025056a2cfa00afdbc918a6ec7486632bcd029d94d07de3b48767f768834cc7367b1722c4b8aa00fa66a7b341aa999f9122571b0fbaf7af4d73b1e7efa9b6b3c7e091ef71bdd40a07c77a6ae148d2a8970ea1cfb56756998322cc7eb98776cc0ae5ffbf51efb84d1a0c12c1f5bb5c9ad966a4566f8eb8ae7b11653037a3e40ab517eb340c3379300e0a05d3a8c1d5c12d5677a61be2b67be7a0eaccbff7b6d2024e7f4f5539d91582e6ca027a7da0cfdd7f0b1e3dfc88f6890a310d3cdea862b149ce3769d94158549962da081bb8d69fda5e60d8a8441a2e548e4fe0acb5680b89d429ca0d520332a4f700ba0d554833a3d00215281264f49d9502f633078d8d54b760dd030bb2d8b04ae13bca0c5c67764539e03b682a9b7a11bd3599326ded1d4b8723197496b821cc436e4dda0bac91f4217cc50b6ad9dad14a5e2d5e5a79f3e75a2467b3d058ef77821fc1813a0133a534a564a1f7aa7ece6431a13de7b2657a2661f64121c63dc0e97f836b6f0a090a8828a60b1bc09977f4fd92ba0070f0b9cdec993c2efe00b106c31072fa0e9a0335fcc3df86cf251a8c3ccf73e5bd99791ca15c48cc143fea715f9a9207f359080",
            "0xf90211a04df2ed308836929bc90ee75887b7aa9377b7f6ec04157b11462e9870407ee52ea001cb14ca9e85b3e6e0f33d3398bab53c35003e76df28f984931f164e3c074a60a0d1655a79b30ebb3e981d99f472996fd8a3f7ab1ce4401e7cbe8bee8473ec44fea08fc53a670e229168b792023586127873ee7207449557903692409bea7072336aa0370ce8310af7107625f0e776ac040b8ceb128cf9e2a2defdb90c92989ba62840a06dcfdac17447a2548085ae9ac1172ceb0a6c373b0769f3b839a8650daeb94a80a0a0ea0d72fbcf15a340641cb7904055c4591b7dc0f908db4c0dfcaea7ffde81c1a0c8457a1be72d03c124f6ecb1ecc0905d588a64d7eaf6e5fd6d8cf5ef969196ada0f2d78e8bbe98c9844c68fa4d94eb05e45f3fa19af5ec2281be315ea2a2fad4e8a0acf53399d1ca521ec2228f6a0225dd542bb3f483334903b42492a4b52d60d304a06f035e4d7b898a7bc786a672017c2ce82f41929121c9c25020ec631a7151a78aa0a1adf7db71a21585e1620dbf95189952420525340ad41cf4e632946201db535ca05cb10516c7cf95addfb685ef2d2c30fa29548a9e6f684c9fc61822837f15aad7a003609750356cf5b27ccd13aaf6ca825a4fb26c5c7dda51c3608bb3295f5b1c28a0f9df0794f618471d14e4628e93ed2e1bfdbd63cfeb753ce1d34fd27d0b5233fca01acb9ade38a52f27638093380b618af646c8f2ca24a8b9977e50eb895afb503b80",
            "0xf90211a05dbe93140054842f90b31a5566a9545a9241d1b55f7f659a754905e34adf2e40a0d67780f575c53aae2a7f39aa0c93a2f64bf4316c01b82b6dffccb91a5a83e47ea037556b4899ab9aca18146c733b0608b1c8d2e3fa038b58b45db70b6965aa76e2a0bd0de68ebb2453193e7f9a2dae77f8f476ab6668961b3bb1de8a9f27adb376efa071bbccffa54056ad7061172a4425aca822bdcfa3e8dea3508ce12e0e05f10845a0e27e900c20bc6dbdf309534003b790d575b34adef90539d7deabb08f5d2f88c2a0867ec5596015b5415514161dda90ba2e39b3c65bbe641d700b1979e148b5eb88a030ce5284d404f518fed0c1bfed663a1d49e9ee146ee3ce123ff94bbeed8b80e7a0cad6c36d92062f64b7c06e60b11f83609cc0beb5de09c2be7bd2fdbeccd691bda0745ffc27ca49a0da041ce80efc26cac0c4210d7f2fe0afc2b53f3bb368ecdbcea0f58f5cbb692270538766ca0e5b09d8d82cc5751054f09eb896e44988a694072aa030e184b8b69bdc718088f2ef01baf50ffe1f3644d1a18bc5ed9b0883b0b2d238a07a7e5b6a6414925c8993c53a9a62c3da831001623393402880bf2ff8231c3526a0520da1917c916b91f5f1b703c52b8b16e0245c71160b727142af82a24ddf6598a0329a58a6ab290fe237200663efe486a8abffa84c4746c847ff09429062e05679a05c1060f9bba1d01bf75d6a004735f78a8af13e0459f5755e373481a0518b3ead80",
            "0xf8f1a0bc0b97d3b233ed18dd5788cc9595dfec8e86be16ad813d881fb2707d1ed08a4e80808080808080a05d61a971068af51e3308faafa22917c85e4bf77a0f389af286a6ba204a384165a06a1a8f4960ba9c913eaa128878bd711d820d01227566b7055476bfa0909fdb3ea0920898a90d4e6b8e69b3f1c1f5571f0d84a0ff845591b81082580579fa2757a980a0412297197ec4e05725315aab4f9850595f5dc381d157a57c2c31419cc7b0c9fb80a0e3676c291bb193233eb8da69b9107cba3385667381b8b3dfd3e6aef580d4293ca06bb728d1139d61a122a2343fc2886efd6ac688a96ab4cec84d6588c5658e87b580",
            "0xe89e20723d2028f3adf07d2f3ed0a2ed2aed33a9c96622d779c2acfafaec75d38887093bdceb493129",
          ],
          value: "0x93bdceb493129",
        },
      ],
    };

    const accountReceipt = await snapshop.createAccountSnapshot(
      blockNumber,
      tetherAddr,
      proofResponse.accountProof
    );
    await printGasUsed(accountReceipt, "createAccountSnapshot");

    const sloadReceipt = await snapshop.sloadFromSnapshot(
      blockNumber,
      tetherAddr,
      storageSlot,
      proofResponse.storageProof[0].proof
    );
    await printGasUsed(sloadReceipt, "sloadFromSnapshot");

    const value = await snapshop.values(blockNumber, tetherAddr, storageSlot);
    expect(value).to.equal(fixedString("0x93bdceb493129"));
  });

  // Warning:
  // This test fails unless `SnapshopLib.sol` is modified so function `blockStateRoot`
  // doesn't verify the on-chain `blockhash`, a change of `==` to `!=` is enough.
  // This requirement can be lifted by migrating from Geth node to Ganache and its mainnet snapshots
  // after it adds support for `eth_getProof`: https://github.com/trufflesuite/ganache/issues/382.
  //
  // This test works on the real world Tether state on mainnet.
  // It reads the balance of the Tether treasury for a specific block.
  // This allows benchmarking against long, real world proofs,
  // mainnet has lots of accounts and the Tether contract holds states of over 4.5 million users.
  //
  // Results:
  // Gas used for createBlockSnapshot: 61617
  // Gas used for createAccountSnapshot: 177863
  // Gas used for sloadFromSnapshot: 173885
  // Results after subtracting `Snapshot.sol` overhead which is
  // caching the results in storage (22K for a fresh sstore)
  // and loading the results from storage (2K for a fresh sload):
  // Gas used for createBlockSnapshot: ~40K
  // Gas used for createAccountSnapshot: ~154K
  // Gas used for sloadFromSnapshot: ~150K
  it.skip("Benchmarks a Polygon contract snapshot", async function () {
    // Response from: curl https://polygon-mainnet.infura.io/v3/<infura_key> -X POST -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
    const blockNumber = "0x1c0a3c7";
    // Response from: curl https://polygon-mainnet.infura.io/v3/<infura_key> -X POST -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"eth_getBlockByNumber","params":["<blockNumber>", false],"id":1}'
    const blockResponse = {
      baseFeePerGas: "0x9cfdda3632",
      difficulty: "0x14",
      extraData:
        "0xd682021083626f7288676f312e31382e33856c696e757800000000000000000052bd009dee04c8d4ee37e37808567d4b5ddf8bba2efcea95f5b2bbd91e4e25713774ad685e14fd9cabc1c1123ae9378304092f50cf9de037aa70a2e5498e651401",
      gasLimit: "0x1c9c380",
      gasUsed: "0x8cf817",
      hash: "0x14ba4e5d10dd6bcda087360d2af9dcfbad21bce00af415ece3a961ecdea7681a",
      logsBloom:
        "0x37f58da92141853046cc04109020000400c4620a80810729c8108206624a2986003116091c40a211b01310d830c143c70911801940022100a2ea291112313101420cd014908b607a4832898bc8390ce0085aa668876400003f4f140882012f08f50002001690a054dbc3b91124c19c4c804640fd220d4621918140700dad03c82051934108087080064c091008648b4424d345bb0222385d0442e8401888800423c405a13890612094287280a38023e4e060001028240c1086c8c428a10069649900840305ae20d12501e0a86baa1502c870a000010899118cd0c1866281306210b400f301848057266929004d228214c282cb450748111344401880001a5e68",
      miner: "0x0000000000000000000000000000000000000000",
      mixHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
      nonce: "0x0000000000000000",
      number: "0x1c0a3c7",
      parentHash: "0x1d977e269b139122e7580ef73c9be0e7ba46e115009ff98619808904205384c1",
      receiptsRoot: "0xb9eceef77cfc9dc2391949895bb36349058b1d9dcf6bf5b6e78c0baacda0d610",
      sha3Uncles: "0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347",
      size: "0xabd1",
      stateRoot: "0xc1b8f611cb276e105e510532b02904468bc20cb084aa3bfe1a8c99c7c1026f83",
      timestamp: "0x62a374b0",
      totalDifficulty: "0x18c4fa13",
      transactions: [
        "0xa9b4ab221ff7257106d262af3c992f284615fa6229c4ea293fe8dbf07c2ddc76",
        "0x1ba4df8519d44f287b043cc7aeb30f472cf30091f4f0b47f1837dcb8adfcd8d0",
        "0x00c849f1384d6e815edf67a583a13e1c0c496cfa46c257b5f2ce5fe9440167c7",
        "0xe67f393e57534e54a0590c72db38b479b47ca84ad268f64ad51d89dd7485bddb",
        "0xd677e7d645937fe369167f846f8e7ac5ac735c2365a94389ef0879a05a4af162",
        "0xab63faf950c9ffade88863f933c805877c97c8b8bcaa87a27df8c90263b15379",
        "0x446b950e37f63f59d23622e6a1ccafad6799941fcc87ce274bf627daa9186f69",
        "0x259c2f0ca6cf0382e0d2dd7d4ca5e0710f8e6abe25932cd4e8b84fcc2a381171",
        "0xe9364f85ea67f1e5fbff5494ba4a17704fb0b753a23563101e6760e89e715451",
        "0x32443eea723a86fdd62f74c08ea0c4809619f35c4ec799d6d4932b707a60eef3",
        "0x0dc45b3884a369f2835f90b9679b3202cd560c5621dbdd774a441d8a89e63bb0",
        "0x1aaef12906b941a4f069c6e536d44aee2d228440b36f0966270a7c63e6ac9892",
        "0xefc220f403e6b2033b1a278f30727b392ef2a6c6df94454984a287db59a57acf",
        "0x87885e9b0ad8c0a240655ab96bff0ca47b67248ed12a0920870553d6ea31f1bd",
        "0x5260d413a19728650033732170d9e6edc24142df1499cbb989fc2eb76442c592",
        "0x5b5e93b55af3e39b782c38701f1fbbead7bf362d1b428a0b83d9277cfbd7e3a9",
        "0x012c28aeeba249350c329319c3a962b79a7e49a5a2cc5afe88ae4d2695c5f868",
        "0x37241326f85d260b88e58ca5ca9c3961c35072b87dc8358626c6630f93323a28",
        "0xf60b4fd5a9945f730196dffe166d45130364044a8be972e86090efeb3a6981a7",
        "0x8c32e0e9c21d0f30c1fd787f86f97c45c5ef139d418c80b7ce6d014b6cbdd98b",
        "0x01f422f5d4db9fa98198f124d1af34f719f866af762729b422dc254a4e200ae7",
        "0xe426ea2317fa0db5bcc4bb195c89d3435c6b65108071340ca230bbfc1390c15c",
        "0x09e9f0762ea9bc5ac62db910ffea0b233d75d4321944b86baf5e7d0f9f3a8176",
        "0x4b2a3c3473126d6cf51b0f582529340ee2241aa1e51361ee37d4afb244f4e86b",
        "0x0b64bff7915559f5ba164f929387e27bc082100897e55d9b92bb3217c9d46828",
        "0x3a10ff7121dd5ec7c63a66eaa146092809fbbb4fb25e09b76b3312157d7c051f",
        "0xd87f5d7bd443b457491e32780de2e2b3d9914bc61e2d014a353b50f8fe39696b",
        "0xe82492b1df0331b5a349527fbf0c38b760130ac49a7004cfdf8928eb9f94abcb",
        "0xacb5ff15018e4efbddc008a060eba9938f8ae58c332e48dd28715a466f6a76b6",
        "0x9973435b563def96d949c600ae784d76e558566642f61402728300e003dcd9bd",
        "0x70773c7a56d4b6dce94785cb2044a422c1319966827b7d6b65c13156acceb149",
        "0x319bb8dda1cc0ab49bfd5de26975df77aa195f502b147fff5ddaebcb96541a55",
        "0x6c05f13f3bc6bb4faefdd59faf3f0c45e878f78c7442ccc78656a75c835769f1",
        "0x3ccef0414cf54ae75be1a8dc92fcd0442d6dd87db3cbe1f747120051ec10dc0a",
        "0x77eb30de9d5a7c795f66c74a081c4b816798a522f6804a9c7e94a90d91324580",
        "0x42417ccc2f2c2b3ce70feee376fe3186d6ef1fa0045e63ad4abab1f6cce31f19",
        "0xda96ab74a583ebb561f36074ad11fc8f3a453194e12c4bb1ddc71c13dd705608",
        "0x2267352e24abc43b244291358d5921734b4e532dfccf2ab9cce28d2bdd444555",
        "0x0b5a6cf09718131bf4ea4cfcb624e1552bb0f82aa420a51b98e7ad8ba61e3e25",
        "0x460f428e3bd10c14fc7a8be75c3655dd00537fd9d3007c59ad4f2470fb658033",
        "0xaa99113e3aa91537c465d7936b0a76e59116bafec599d72c809150e2dbb7b47e",
        "0x5b626bc5c854cd29c5d8fb61ee10d940ba03ce1629929e55c9d0e9142869e650",
        "0xf670159a667e6e46c46ad936c342dc922c2d02d30c1d56a64b10791f4c850755",
        "0x591f26d6e42afff7abf6cc3c0fc2fff983b966ad90a31502544a64f84d49323b",
        "0xdde2b84bc9ef7ee5c31c5eafc067c82e8996d8a5b2dbd83063432ac2fcc9b614",
        "0x55a80c7a5bca7f4d4738970adae3359916bd65606a06eb068dbb593bf571b030",
        "0x69f6f5df5516bb952a56c0920cf716cfaa948e5160bab6e002551ad97e005356",
        "0xd94c804113bcf40a6e50be6b49f7818a5b7623d881fc9f78be804295713a42d0",
        "0x3c428f0e112a5273b29a3b20441a0b0d027a70ddb2e08fed1f5213d6a6f80e13",
        "0xf0f1371a483bbd0f88b51ff1662df05b5a2433679a4eabec4bb3a1ed4e8542b1",
        "0x4dad44d225d0f9d8602424123fb17d1a298dd1741b870a9a68479493a8fd4bdc",
        "0x193bd326b5ce0603f14526cec1fba6da70ebc9607013ea6246e47024eff1c3dc",
        "0x45e4f5cf38b1388cc1561b18f0357e43862a1fb791a302afa944530f5d6127e8",
        "0xf8930d17b8ae4999c8107b0f99f8dc0e9bd7b18012c9a41be47fc523e77ca081",
        "0x11ee5850946808b2547ad7a989c2ae21846a8576bcd7f0a81eacefa51469acc3",
        "0x2169cb75ee1f89ed91c8dc0b441e656c6106f257a64098bbcdf27b6ed5e9c4d5",
        "0x3a9540fb67e618b0f0ff20dbf0cbc238d59791bee7307183c5b0dc1ba1dbf453",
      ],
      transactionsRoot: "0x692fc3a0708cb7896102d9ab325eb43b4d4df169cb6493bb3e862571414d1e4f",
      uncles: [],
    };
    const blockHeader = formatBlockHeader(blockResponse);

    const blockReceipt = await snapshop.createBlockSnapshot(blockHeader);
    await printGasUsed(blockReceipt, "createBlockSnapshot");

    const wethAddr = "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619";
    const holderAddr = "0x28424507fefb6f7f8e9d3860f56504e4e5f5f390"; // Aave: amWETH Token
    const storageSlot = mapSlot(0, holderAddr); // Balances mapping is rooted in slot 0
    // Response from: curl https://polygon-mainnet.infura.io/v3/<infura_key> -X POST -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"eth_getProof","params":[<wethAddr>, [<storageSlot>], <blockNumber>],"id":1}'
    const proofResponse = {
      accountProof: [
        "0xf90211a0f9b98c2e70aaee5e96da155f447cec6e9fc15df6e5f664370507ff5e17566955a04bd3741b8e7daacbb2e5aaaaa6948d02efb0a3f291c881bf65fad00f83f9f7e2a08da76e0fa2b83e45c6e7c1df48b25d4e3f8074b22a10879de71b02d3ec0caf1da0ee90da825e34fde75c535c3be2deb3c51b0df6267b80c1cbfba38cffd4c31e38a0c54f848aa9d066fde296a5cfc0f558116da3cdd6ac181b57df521e92f190d009a01ab98a1ccf68b0f45bb6906fe5c9f91564ac05b4a4ede8894ab5adcca91b9620a03548c1ad9dd72f18f6a1d5375d7ca5a091fd50fb1b308e004ac679309745734fa080552a0449206e748150bca872bf63aec3a33c26ebb4066ac0677bb3aa766c18a01bcdfe36fe89acb5458703e6ab86398092f66ccbfdaa5de5bfa95e0db7add3cfa0d3948a95008d175415619cf5afdc48f1012068a9d139843c677defde393b3a06a04ace0f80a6495fac8406efc0d3e091a441bdee47892ec7c1b9ded7295ca3ce5ba0fe64629beac5ec95f3b09c60113f0103627dfd5464fcb38ff215eaf193c2ebb1a077710dc6acc9a52fc1782213fd2eb25921bf16dae4300b55d54f785c142a4028a09978851feb5836b0a7279d7b87b1963c5a4bad150e22cb3fb8102c19dc1bff0fa072db75bd80e02e8c63a75b2ddce67c24ea8df3501d469e3e95a7ef52f1f7000fa03e8df27646ce143665fdad6d2dd3afeb8a5f250195307499fe61db989e93606d80",
        "0xf90211a0f067d94b0be24c59be99f44ddad73342db34b4260c3aab850b5a13cc4fd717d6a0217c6e6cbe6639da36a961b4c26f22b3b5d464548bc38dc65fd4d638d245ca07a021616ff7f8531105ab7876e6233e1cd72ab8ee7c49f6f38fce4198cf89e40ca1a0c224ef761bd57e980bdf587c89532aba7b86f2c7837888a93f4662a43de4e9eaa07ddcdde6ac5472089f5a87f9d1af377f89d479728e2009d1e2c507cf5dde2e93a02348da36084fb8b572cd99bd4b6914cdbd17dde9dd212e571d4e3a1cbdd58e60a04d4461a003ac0fadc86c88bfb4a66638ddd9541eed14ec70b9526fb2e87f6595a0ea3f27ff2231d7755a4ae7e37778ad8eec60a020acdbe5b65a980693d82cff6ea0939b08941a0a88e2530dec1b573bf46971d8827b19f15d0c8ef449b7f32870c0a0a55f3be5cbcb3b393eb5f7c02168d6fb51e69b0cf0a27f3c6e950a82751d93fba0e5bbf65b704f774081d9da336667deb92da92ab92f43550143a907b5ecfbec61a0b35326275c77d2ebe348fc0153ee6f23ec83ea72e21fa5c7eec4672de1b107d7a06d0bb59e5f89d4e1cccb09eb9d19a48b6c72ef4ca589fa95e98b54e035dbff4fa026b7ba64c845d795a7d14a163f5fd51c5d878b02a78ff3fac50f2a46b2e094d4a04544eceec39591e59beaea4f33e1531a90969f2e6bb895427abd76538ff9a9bea00e75bc30724bc51cc626dc3ba33218e04ae583990f40f458862ee207fec8ba9880",
        "0xf90211a0871785b5f710fe24695f355c768f769a6ef4705624627504dbfff059d45e47e6a0b2554b2a77c53b1486562e705c4861d57e8c86dffac03ea48a85e40b416a287aa01cd67aa3c1c07a5ed6a230a79c2d2820add849f72ae6ac69eb135a9aa74e63d2a0c9862cfc842d974f5f264cf4fbf2ed17f1fd720b61c82de397f1a9dd4f45428ea083ea2f0c6dc4a44e905df67283f01ad9fa8bab88e598afa6907bd09e3b6cb1f6a052680624359bbe4a7922d267e10525f6c38f9866929433259974c3211fc6d7bca0e70b64e9c78f445f11b767ad4b6bc60a7b1ae1218e8e566fa432267ac2235813a019434c9b9f327e3fd13c69f22df1df84a20d0c14464d05bb1d9986f3926f8919a0ce8369b38515d82143d40806b4b0adf027df3f00a00a33a763dccd42d08c7393a07ff0a1097978622c0b46bebaf92109809a7141b484b1b2424716ed9169757fe3a062046c34c095f9764cd07780da0dca95546bb7c835c6587615202494779cda5ca0e72772b3d722184be2964c54ef4bc06e23e18f97ca78afe945a041227000bdcba0eac6c9a9ca034bc87de8dd7d1bfd59a940fec76df0e5dace44a3fbdef7159c14a0ab58a75c090979457dea7260f00786f7c76c1fb05380c8ab5bca06f9fafb11c4a0a1fa6165f752fae157fb441e2b52ded8ea5ed6dfb128dd6db03124baffceca84a0876d6f8d9aeca3d07abda7302131635f773043f4f17b2a74f46f64332afc339580",
        "0xf90211a0e39a635722b766c15a0091e5153b42656ca2b6cae2f80c0e31029aa12ec4ae15a045db02e0939715a6aadc0f60bfc17ecbefa7e00eaac1858a1160cdea63f09d93a0ab9dc0df2ea25b88b5d174f9e3dba0facdb8982aee53e0a76bc49d719d4fec09a007a2843e977c972236485407026e21531cda59b4e1bd67cdeb3963527082edf7a0955ab3a8d5c9c85dc99cd5db0411a76a48333a08c01b70ada5e91a26d874ecb5a08103dfcf7dc9be06bd77e4c54e722819e5fe723309395b9a476fcfa76bf7323aa0249f074db00f2fe25f53bd300768fe3448ead3aac6ab8fcc9807c84444a3de63a05c056d3b601f9beaf21940df300c71272f5d38bdeff456df3e1b4826b2b3b253a08da387c1f45146f2acace0fdc5621b3e832beae2f77b5180bfeecdd0940b8a74a0bf6b457494299f4d76aacdd03416c2dcd84b15573dfa2831c98ffd6f5df39865a04c6740082a1ccc10a4a7790de0ba651408052663904744f1f748f0cd46bf4735a0d8d5a3b65b0411798510b75af39710cd3e383c93dafca10f0f42db8aa3ef8c01a0a761408bc89de1682ce3ac2ae9604ed13b68d660f3e62291d26b5e3c8f61a443a0f4dc3c0f4b6e7c8a468005ac1a0db95bb5449656f762df9f18ce6597245d7e2ca0f6cf81d44fef6eb820ef03a9aee2939f97820f13db7f35f588ab7e063642697aa0d787cbcddb0cec279f706d99ea9865c306998ed2e8ad726c3dd6577706edd79d80",
        "0xf90211a0c10285dabca40e8dd106783e39a7459b2ed0a2125520fc88b575fb3712b2ef02a03d6b380b9ebbe5362f5c6f900d873b0888848d6fcf1b0e5a714b7f25a8a75633a0b4aad609ebdd4165c92663da1a275ceb12bd32d2acb1fc614fc928a3934ec2f8a0f3e03a3e408bdfdb89c68fd15505be26b2ae8f7189480a7178b4a2ebfc446ae5a0693b8fc88dba7caa9fc500ccc7c46b5a2676a507330291b20f2b2dcbfd9f76caa077d913d97a3c43e77a7f9abcb015d0cc421694980b5347a137dea04a19021391a0fdad8cac825a8adafeb9eded50468d0c130652775736b4ef959d301cedfb25fca0bbe8745b912473b54888a7037a4176be78a7df239c75c93e080063b73555d8a3a057bbfa40fe37db8f8a0fb544f8d89d4f795d4a4ab4b10578f03f826c915e5547a060810ae055c7f664f10f80f90ba398b4265d7fafea9377fb79fb9d6bcb3d47a6a0c4f9a03911c0e1dee37882a81974fd85436f8589e52a419958a0a6f2a016094ca0b3f3edfcef85d58898a7824e3aadaf0735db960db98cb2981e425e0debf4ba04a0522293badecdbc1276d0a6cc02c64aac448e4cd295c8124be7d4678efe1b05e6a0755bb24a0f2a5b1e5cf14812d1e7ac2394f1aba5c1e8e875c0bbe8ba8f442570a091088bd5e57e9e38d998f577d60c1097c88faa20ba0484529b18e344e63d7163a0db75279d974d10091db464408be58545df50c4097ce6e1ca25387e543a407f9280",
        "0xf901f1a01f52827d19e706986898d47e3b79cbdde3554865b020064484d3bfa6d02aa0f7a0f78327e7d925e42acbb63441483f0022012ea8d76793a4892ab43c8d11667034a09ca2dc2f5894da8797c616c056817b8f65bfb5ddbd9c5e269d9080dec58eafb5a0b451cef217679b48e93d695be86717eeaa4fa7ea38a9091f0d761712b882e141a0b726dddadac3994b68bda7fc519a4330421f3572d8f1ccca3a86c627f6a3be17a07dcfdd005fed39e5d32913ceef8db5f0f83b63712b4a47a72f41a8d1162d5053a0a0bcbd34faee251c0294a977b467fbfe2da16e182f6f16ce7f100b569079a768a091161afbe7b8276d1a29f9bc4f6137ee396e609de6429a22d27cf9e68fd25b9ea051fcc86bdb7f446ad045b34460f6374da4da5e857c68e37df8a328a1de27fc76a09501e8067b3a5186c959176562478c057e5851503497117e8e906db4630fa3eda00a18c0a07018ba73343977084e3b5b1250f6cca2a04b47f8271716e829ddf72ea0906c0e86754fbbd58b4125b024f8871ec7a3290779f3319e47d02a3ae6d216c880a0c74c872e386224bbd633e930e31159c40d84bbfcc4bc1c4fe744f1e88a8cca42a047be5036999677135fdf9978ce702900cffada31b31f72a701e51af81c8435f8a01013c5af0f9da2ad12284958b4b33692994ad08b513cb815d8265359c32f388980",
        "0xf85180808080808080808080a02360eb8e13928f584fe54e78970ee36018da64d15570d3eb7aca4df31bddf4e18080a0172e7e05bcf9ef11df363abd784f334c174d1911339a307388621d845c2194cc808080",
        "0xf8669d39707f0bb7dd7b0b6eab56a89d3d93b2ce51287c639cc0f949238eaf80b846f8440180a0219511ea183f8705cef331bb66abe0cb498b803a10e571d3c56cd02bd1f909dea006025eef5a4b1b3cb0031bce61d6a571f478e213d24984621eafcb59b8d71473",
      ],
      address: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
      balance: "0x0",
      codeHash: "0x06025eef5a4b1b3cb0031bce61d6a571f478e213d24984621eafcb59b8d71473",
      nonce: "0x1",
      storageHash: "0x219511ea183f8705cef331bb66abe0cb498b803a10e571d3c56cd02bd1f909de",
      storageProof: [
        {
          key: "0x505173813f2b7bedacff677593c0c7149f5abd8eab1504675212e0c76b4bf92d",
          proof: [
            "0xf90211a054c5292bf8f1bce4f8b020c05246b87f3624e962c6892ca9568d2c3b1db6009ba0b6d1dbb49d053b28eb2d504321b15f23f314867019e5d061876ef3d1b62e7d24a085445a3f8c7558b9c22116689b9620ab3703f5135ca1cebb9f790ec576df3bd8a078babe29857367e5e7026288b0be89d10d8b71d22242019a45b4cf2a445814eba0ace878d364f225a1c689a07fc774c08b62b8a7f93c6025a08a102870a8d55e01a0d7dd1a3ceee901d50d2f08bc2df2dee74407255bf697dfcdfea6e3e0d764f39ba073ba986b586f17edabd2c2e752eb59f1231e64af73a01c63b1620e5d80259db9a07c30fe1ce0de0e1b34049773a93efc6ec785d9ec2c6039621d79de7c3c7be25fa061938d01d1a609ef6cabfb45139cb03481c244a2f6d28706f4131b500f00279da05feecc334ff62f573c1a51d812cec7fdaf9be1d4b296054a32d8e3e6b8b02e8da06af520c8fb9e36a8dfc922c3e1efd5b9c2a0e0a0a8981d2fb889913b13b3a412a064b014f374c4bb41261b868ea9172ba7886d790c2ceae6892c44a0ee97896821a0e7cc63eee83d2ad46c16e1a58d31e5f210001aee2b1b77c374b216f677536951a033b45dd6611b307d7bd77d43c4f5da3867d25a74bce26b92fb1045dce580dc4ea02ffba948232f67dc90d743704c437944d9cd3f6c071dff5909d7c445a0b6c3dea0b2d50c90d8c7b207a128c0155b031114eb0112501818af4987c49254aa0d143d80",
            "0xf90211a05b630872bf65c77dce73f872972559e351c956f70f92f147e0087adc9def762fa00840d3732a54d239dd1869686945f2d2253cd6fe60af606a0887bfc64a916b73a079f8bee7e35f343b49d74e1c90290b842a08ed54c5800238123f435672f3ed93a0a3aab799712bb3e3bf7a8afa4f7eaf217911e92575fb1f75d2efb95d7e234ebea0ebd0ad594f71ac7bab4a9010c7048cf0dc0b56804b996b0443b361d1e4b89875a06daf74b6d66c930c2a42732cda0251f1f926441abd6f57ddae8c9998308aeafca051ac4379b3b22691b64353fd3dabf57b87a9ef4508e33c98ccce0fb043e4cd81a0cc7e1af8a0b5827ed83b48d95ac3a65f8d4906e8b6d8bdc9485527b4834f1613a0ae87f7defa572a8c00fe67e0a219f9ef45d0b4be2be7723a814a160aaa2127c3a03be06ddd37e2c5eb9574f4018587b1edbf444b81737de4354220e65cd4f54c06a09587e4720f0699a81063fcdcb37dbd43bd06f396d8838aa9fcfb8ef03e05e509a0f502828f540b6819ba791549ddf210a740fd03c526a051f47e0619b2f41bd43da0d1d6891862f8b2904ebf60eefbdb037ccd887517e0686c188af4eeffa0249a9fa00916d98165aa83a2d7e66d2ee8cae6c8a2e416b758b037935781f6d5485e7453a01c4440aef4599cc5400b4e829fb7304cb030bd5f582aa57ddf92fb39f1127687a019cfba084ab8875b6687aa4d7f3c169cbaf71fb3382a94640b35f35964c7067d80",
            "0xf90211a04333fd1d7e132974c7988dc81321b000081967bcc9f32d3c44fbefcd65bbc3fea09088722ac88b9304f7bdbf50631c904f36ce166baf1c505dd51c5bebe747f42da0b85e461c35afc1ea853192fb4df830613270be68867ae11275a6fc1f36a2807ca0a28682f970936816cca82cbda9c056f3d51407b6ddd062289507f3f73abbbb57a01d9481b91492c1403adce188acc1856883231464442c2eef1ae49e570b7eda1fa0e95ad1ae695894b357dbde4d229edef8c210a5f9e8065dca0cfeb64a0e31781da0eb9f122d47c5233ca191b99003d88757cdb2abff9599db42d6f405489bcc1c9fa0909a50476d8e771098c85768647b840a7b757415d4bef30cc72910cc4672ee36a058465ade9d6e16c1b9726894c546f33e2f0d83ace4819dbaa0361037a95c5e11a005111a3121c79c87584762934ca66127e602bdbaa9ee374ab826266f86bf0992a08e76fbf79ffd8c92f304326d2ec4e278e2e01a17625ffe14e502bc9314a680d8a0cb838b8152f6b4ac09136581118dacf12797379b6732f9f1c3fbdca78bca4db2a0004c57dd11755648ea1c815ba3477caf0fa7e93b39b688512079a03650b7b646a09226090afc7ef07dee9978e14225d97c9573081208e7e4d325be0c3377eb3e7ba0e1d84454e25165cf47cb58f0aa0c489da14d9fa059f482b72617b7bc673afd59a0e2f8291d07485e7b3c3bd068ab67a113863f6b038d6d6c8b54342a2b8930259b80",
            "0xf90211a04dbb19d40b08ce8f8506790b8d90407e3010a6165f5e5e2530d04092b5970d44a059a2ea060076889c9f434b5bfc52c0d3a8f9dc08bb1fb76f9051b6aeb30e8000a0c9dca16ab67fff2d2ba3d83ba3cfd50817ad50ee100837d54c9037c8651f841aa0f9451c99d5454ecdba51a9661d6b216c89d660c94ac32a5ddb3fdcc61e4dc687a0d8b27e7c593739a85aeece9ff3e87ecc9a37e0f6d87e5531064d28ce2e7f0de5a0f8de3a6e438799d964bd0a52ef419f019aee658111f9fde522f462ef0bac8f03a03080d6aceed3f06be5441696e6176b8596fe3c9ea46699415b46970d4b30cbb7a02258eea90461a5deb42de28d4307370b3659f55340b800b59160e1911e47bc86a0207dca6428d55caaac8b4889a1bac4c3f8623251aaae9700b0342cb1d643c4b0a067fe62b6a405147883f99669213ae05f3e8080ec8a43abd5585cc16517ba8f6ca0a560438c38986415eb11ac45f28f7242d9d61f328925573d0efa5af1a31deff9a0407d2a6b454665864a3dda1e588797dd0307f8c6126bedcb171fc5cc8ef7ad0da0c65c139a2876818ff2718ca61ab4560ad74f102f5a1863fc9698ee252e1252e3a094b42dfe4c960fa41d0b68d263d93a0d8141ec5b43a142903807cd53526e4268a0cefdae4e74c85546bc997d1bfb61c19e6e5515c93da82530772604e6d8424f90a0f6bed1a4391befad618bac7ddec83405ddac5d115b687820b85a5f898c51e70980",
            "0xf90211a082fcdfcf9cd6871c341676369433b9c3103ac820e013f1eb11fe0ab1c5c386a6a09c43e579433b354c56b49a5c1fcfa2f1eb4a7c2027daea3a8e41101a1bedd570a0905c87ceef1888305f8c221ab470ae73363c869b9ad300bd4d6783ea0cc4057aa046f302ef0f0d6b03d1578850a8c7c6f51c8f7595216c072f5d3fd8ae3adda4aca03b28fefdc6fc183814d3582d98884b4fec8182bdc95611002b067924d6a8395ca027a4c0b29b7dfb146e05dc8cb7474860bb4632e86b4e7773938c0c660b2af5caa0f98c9bcf1cb6c8b817c01fc075c91c55397794e69acda5b4469a27bfdefb4098a002fdb8b35d417dc453b018c0145825f6fdedf3f78591e97ef893c9ecf6cda3c7a069926eaf2bf3dda2aa03b4191818db0935888befb6dac1212a14c2dcb6809fd1a027252505801cb73fb4afd16151338b0584ca579c9a2806a641abb9ebf049d880a0ee0f5619a6960235ed28f49ea21cacd8e359c0a0177fb3379b535b8f6b0d270ca064265088a40f1f6e4aeacf7f4e023cc8f0937255756a07c31779b4358b9e8afba02b4e908eba6ce0dbe475902508d59a18857d35686da42c86a14dfed7287c6954a0315f9103b5e1e257e3dfe255cfdf5ec1cd1c2b8e48d7cbea781a3bc43bd4879da03992c81406658b3920f03d9e3bf3ce778054906bdbeff96eb100475e7e73824ca0ad68fb5d0cd2fa42e6daa5c604fe5460487fe27882f5d8cb4dd8ad99232160b280",
            "0xf9015180a005962fa6a0230b206f0e870198b2d62283fc387237cc98e7eb14b73879a85ddaa02ef63de5003765f93f420f314005502e120ed60f8d4fd115f87007be161c4a12a01cc8399349d42b314cc0bb595ad5f92e759aad3efa0b52043626c832581708168080a0b2a84553d2e2404b5a8819bf901a2fd2070d0a0a0b96d2d3eb826c254b83fbbea079092a0a7311ad5b390ea90f73adf4e6bb7aaf953dac406ab06363b5346c7db6a0baaad427ecc3ce2a0249ee17d3a188c75c4bc76f33c75c569a3a8123a499245b80a06634e2b655fc060a4cd7563befc3e396e65a721208ad8aaacc39c8a6b560e11ba082070818a5053aeaea842980b961b793cc1a64ac5aeb85ce02be8901c6cf2d5ba098dcda52285e06f6f7959fd32375e287b9e8e8b5d3a7e5a3a43dca59f470ed488080a09b0b9ed4e19a20a00dfa60b742b1903c3c9327e6b43115449ef3e9f83865580580",
            "0xf87180808080a0aee44d3185703dd2723930aa4e3d2c4ecb0e4caeeb05534c497dbc7830984b3f808080a0822e077b2e361f6151f20ac58228a6ae56f0554d26f95a9da802a74bd82dc47c8080808080a0ed58c217ca1327e2efe1ff17004580e9d9c04162952c9f726d5590472814958b8080",
            "0xf85180a07256c55c2ab1739011e7ac5ab17e33820e9c7b461927a320373afa05f967b31480a0a1e33da96713e3436d663ba9b6adc7621a082a696d1db9aedde26b20a9995cc880808080808080808080808080",
            "0xea9d20446fc80d8fcd5841c313cd9d41e9ce7b29761e56dcbbd5344a77094c8b8a167232d45e8fd397b17c",
          ],
          value: "0x167232d45e8fd397b17c",
        },
      ],
    };

    const accountReceipt = await snapshop.createAccountSnapshot(
      blockNumber,
      wethAddr,
      proofResponse.accountProof
    );
    await printGasUsed(accountReceipt, "createAccountSnapshot");

    const sloadReceipt = await snapshop.sloadFromSnapshot(
      blockNumber,
      wethAddr,
      storageSlot,
      proofResponse.storageProof[0].proof
    );
    await printGasUsed(sloadReceipt, "sloadFromSnapshot");

    const value = await snapshop.values(blockNumber, wethAddr, storageSlot);
    expect(value).to.equal(fixedString("0x167232d45e8fd397b17c"));
  });
});

async function assertSloadFromSnapshot(snapshop, blockNumber, account, slot, expected) {
  const receipt = await sloadFromSnapshot(snapshop, blockNumber, account, slot);
  const value = await snapshop.values(blockNumber, account, fixedField(slot));
  expect(value).to.equal(fixedString(expected));
  return receipt;
}

async function printGasUsed(receipt, callName) {
  const gas = (await receipt.wait()).gasUsed.toString();
  console.log("Gas used for", callName + ":", gas);
}
