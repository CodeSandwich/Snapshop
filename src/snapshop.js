const { ethers } = require("ethers");

module.exports = {
  createBlockSnapshot,
  createAccountSnapshot,
  sloadFromSnapshot,
  getBlockHeader,
  formatBlockHeader,
  getProof,
  mapSlot,
  fixedString,
  fixedField,
  dynamicField,
};

async function createBlockSnapshot(snapshop, blockNumber) {
  const blockHeader = await getBlockHeader(snapshop.provider, blockNumber);
  return await snapshop.createBlockSnapshot(blockHeader);
}

async function createAccountSnapshot(snapshop, blockNumber, account) {
  const proof = await getProof(snapshop.provider, blockNumber, account);
  return await snapshop.createAccountSnapshot(blockNumber, account, proof.accountProof);
}

async function sloadFromSnapshot(snapshop, blockNumber, account, slot) {
  const proof = await getProof(snapshop.provider, blockNumber, account, [slot]);
  return await snapshop.sloadFromSnapshot(
    blockNumber,
    account,
    fixedField(slot),
    proof.storageProof[0].proof
  );
}

async function getBlockHeader(provider, blockNumber) {
  const block = await provider.send("eth_getBlockByNumber", [
    ethers.utils.hexValue(blockNumber),
    false,
  ]);
  return formatBlockHeader(block);
}

function formatBlockHeader(block) {
  return ethers.utils.RLP.encode([
    fixedField(block.parentHash),
    fixedField(block.sha3Uncles),
    fixedField(block.miner, 20),
    fixedField(block.stateRoot),
    fixedField(block.transactionsRoot),
    fixedField(block.receiptsRoot),
    fixedField(block.logsBloom, 256),
    dynamicField(block.difficulty),
    dynamicField(block.number),
    dynamicField(block.gasLimit),
    dynamicField(block.gasUsed),
    dynamicField(block.timestamp),
    dynamicField(block.extraData),
    fixedField(block.mixHash),
    fixedField(block.nonce, 8),
    dynamicField(block.baseFeePerGas),
  ]);
}

async function getProof(provider, blockNumber, account, slots = []) {
  const slotsHex = slots.map(function (slot) {
    return fixedString(slot);
  });
  return await provider.send("eth_getProof", [
    account,
    slotsHex,
    ethers.utils.hexValue(blockNumber),
  ]);
}

function mapSlot(mapSlotRoot, key) {
  return ethers.utils.keccak256(ethers.utils.concat([fixedField(key), fixedField(mapSlotRoot)]));
}

function fixedString(value, length = 32) {
  return ethers.utils.hexlify(fixedField(value, length));
}

function fixedField(value, length = 32) {
  return ethers.utils.zeroPad(dynamicField(value), length);
}

function dynamicField(value) {
  return ethers.utils.arrayify(value, { hexPad: "left" });
}
