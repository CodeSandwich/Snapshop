//SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.14;

import {SnapshopLib} from "./SnapshopLib.sol";

contract Snapshop {
    mapping(uint256 => bytes32) public stateRoots;
    mapping(uint256 => mapping(address => bytes32)) public storageRoots;
    mapping(uint256 => mapping(address => mapping(bytes32 => bytes32))) public values;

    function createBlockSnapshot(bytes memory blockHeader) public {
        (uint256 blockNumber, bytes32 stateRoot) = SnapshopLib.blockStateRoot(blockHeader);
        stateRoots[blockNumber] = stateRoot;
    }

    function createAccountSnapshot(
        uint256 blockNumber,
        address account,
        bytes[] memory proof
    ) public {
        bytes32 stateRoot = stateRoots[blockNumber];
        require(stateRoot != 0, "Block state root not set");
        bytes32 storageRoot = SnapshopLib.accountStorageRoot(stateRoot, account, proof);
        storageRoots[blockNumber][account] = storageRoot;
    }

    function sloadFromSnapshot(
        uint256 blockNumber,
        address account,
        bytes32 slot,
        bytes[] memory proof
    ) public returns (bytes32 value) {
        bytes32 storageRoot = storageRoots[blockNumber][account];
        require(storageRoot != 0, "Account storage root not set");
        value = SnapshopLib.storageValue(storageRoot, slot, proof);
        values[blockNumber][account][slot] = value;
    }
}
