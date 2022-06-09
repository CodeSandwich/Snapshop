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
  it.skip("Benchmarks a real contract snapshot", async function () {
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
