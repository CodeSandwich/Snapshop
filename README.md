# 📸 Snapshop 📸

Snapshop is a tool for creating on-chain snapshots of the whole blockchain state. It lets your smart contracts read the storage of any contract at a given block. It can be used for on-chain voting, airdrops and many more. Works on Ethereum and similar blockchains like Polygon.

The tooling includes:

- A library with the on-chain logic to use in your smart contract: [SnapshopLib.sol](contracts/SnapshopLib.sol)
- A smart contract wrapping that logic into a commonly available generic utility: [Snapshop.sol](contracts/Snapshop.sol)
- Helpers for Ethers-js: [snapshop.js](src/snapshop.js)

# How it works

1. Create a snapshot of a block by providing its header. It mustn't be older than 256 blocks which is about 1 hour on Ethereum mainnet.
2. Extract the block's state root for an arbitrary contract. This is done by providing a Merkle proof of the root.
3. Access the contract's slots values from the snapshot. This is done by providing a Merkle proof of the slot.

All proofs can be obtained from any client supporting [EIP-1186](https://eips.ethereum.org/EIPS/eip-1186) by calling `eth_getProof`. As of now, it's been tested with Geth and Infura, but probably other clients support it too.

# Usage in on-chain voting

Snapshop can be used to improve on-chain voting with ERC-20 tokens. A simple demo is available in [TestGov.sol](contracts/test/TestGov.sol) and its usage is presented in [snapshop-test.js](test/snapshop-test.js#L133). Here are some advantages of Snapshop-based voting over popular checkpoint-based voting.

## No self-delegation requirement

The usual approach to checkpoints requires the user to delegate votes to themselves before the voting begins. This excludes holders from participation in even the most important decisions if they haven't declared interest in governance beforehand. It facilitates a clique of regular voters pushing a controversial decision against the will of other holders who haven't been active before.

Snapshop allows dropping the checkpoints system altogether by facilitating reading balances of all the users from an arbitrary block. All users have the right to vote if only they held tokens at the right moment in the past.

## Fair gas cost distribution

In checkpointed tokens, self-delegation is disabled by default because it makes each transfer cost considerably more gas. It gets even more expensive when somebody creates a checkpoint. It's very cheap to do so, but then all the delegating users need to use the new checkpoint and pay for the fresh slots to store them. On the other hand, casting a vote is relatively inexpensive. It's not a good balance, because proposals are created only once in a while and votes aren't cast that often but transfers are made all the time, so they shouldn't be an expensive operation.

Snapshop reverses the pricing. Transfers are very cheap because there's no checkpointing or delegation overhead. Casting a vote requires reading state from a snapshot, which is more expensive, but also much less frequent. Creating a proposal is the most expensive because it requires creating a snapshot, but it's also the rarest operation.

## Tokens and governance decoupling

Voting based on checkpoints needs to be baked deep into the token contract. It's a complex piece of logic and ideally, it should be put there right at the token deployment to avoid risky updates. It's impossible to choose the state of an arbitrary existing contract as the source of the user's voting power.

Snapshop allows tying voting power with the state of any contract without modifying it or coupling it with the governance system. Any existing contract state can be used, whether it's an ERC-20 token or not, even states of multiple contracts can be used. For example a simple, non-checkpointed ERC-20 token is used but extra votes are granted for being registered as an owner of another contract.

## Settled state

Checkpoint creation is done inside a block, which means that it can freeze an intermediate, malicious state. For example a user can have an unsettled flash loan or the miner can sandwich the snapshot creation with a purchase and a sale of the tokens. These aren't undefendable attacks but these risks exist.

Snapshop uses the states of the already mined blocks which by design makes many attack vectors infeasible.

# Gas usage

The gas usage has been tested for two extreme cases. Depending on the network and how large is the state of the read contract your use case will require amounts somewhere between these cases.

## The most expensive case

It's been tested for Mainnet using the USDT contract. With over 4.6 million holders it has one of the largest states and requires long Merkle proofs. It's practically the most expensive scenario possible.

- Block snapshot creation: ~39K gas
- Contract state root extraction: ~163K gas
- Slot value access: ~155K gas

## The cheapest case

Another test has been run for a local testnet using a contract with a single storage slot used. It's the cheapest useful scenario.

- Block snapshot creation: ~37K gas
- Contract state root extraction: ~80K gas
- Slot value access: ~10K gas

# Risks

Usage of Snapshop does have some risks.

## Storage layout of contracts

Snapshop will blindly return the value from any slot it's requested to read, no matter if it makes sense in the context of the contract's storage layout. The tooling using Snapshop must be very carefully designed to read the right values and interpret them correctly. Any updates of the contract logic may break subsequent uses of a Snapshop-based tool.

## Block format changes

If blocks change their internal format, existing deployments of Snapshop may not be able to work with them. It may require updates or migrations to newer versions of deployed contracts. In the worst case, it may not be possible to use Snapshop anymore.

# Development

The project uses Hardhat and requires npm and geth to be installed on the machine.

Running tests:
```
npm test
```

Running prettier:
```
npm run prettier
```

Running solhint:
```
npm run lint
```
