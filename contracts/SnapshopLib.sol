//SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.14;

library SnapshopLib {
    bytes32 internal constant NULL_NODE_HASH = keccak256(abi.encodePacked(uint8(128)));

    function blockStateRoot(bytes memory blockHeader)
        internal
        view
        returns (uint256 blockNumber, bytes32 stateRoot)
    {
        uint256 offset = _readRLPList(blockHeader, 0);
        // Skip parent hash, uncles hash and miner address
        offset = _skipRLPStrings(blockHeader, offset, 3);
        stateRoot = _readRLPBytes32(blockHeader, offset);
        // Skip state root, transactions root, receipts root, logs bloom and difficulty
        offset = _skipRLPStrings(blockHeader, offset, 5);
        uint256 length;
        (offset, length) = _readRLPString(blockHeader, offset);
        blockNumber = _readInteger(blockHeader, offset, length);
        require(blockhash(blockNumber) == keccak256(blockHeader), "Invalid block header");
    }

    function accountStorageRoot(
        bytes32 stateRoot,
        address account,
        bytes[] memory proof
    ) internal pure returns (bytes32 storageRoot) {
        bytes32 path = keccak256(abi.encodePacked(account));
        (bytes memory leaf, uint256 offset) = _proofLeaf(stateRoot, path, proof);
        if (leaf.length == 0) return NULL_NODE_HASH;
        offset = _readRLPList(leaf, offset);
        // Skip the nonce and the balance
        offset = _skipRLPStrings(leaf, offset, 2);
        return _readRLPBytes32(leaf, offset);
    }

    function storageValue(
        bytes32 storageRoot,
        bytes32 slot,
        bytes[] memory proof
    ) internal pure returns (bytes32 value) {
        bytes32 path = keccak256(abi.encodePacked(slot));
        (bytes memory leaf, uint256 offset) = _proofLeaf(storageRoot, path, proof);
        if (leaf.length == 0) return 0;
        uint256 length;
        (offset, length) = _readRLPString(leaf, offset);
        return bytes32(_readInteger(leaf, offset, length));
    }

    function _proofLeaf(
        bytes32 rootHash,
        bytes32 path,
        bytes[] memory proof
    ) private pure returns (bytes memory data, uint256 dataOffset) {
        uint256 nibbles = 0;
        bool foundLeaf = rootHash == NULL_NODE_HASH;
        for (uint256 i = 0; i < proof.length; i++) {
            require(!foundLeaf, "Proof too long");
            bytes memory node = proof[i];
            require(keccak256(node) == rootHash, "Invalid node hash");
            uint256 offset = _readRLPList(node, 0);
            if (_isBranch(node, offset)) {
                uint256 nibble = uint256(_getNibbles(path, nibbles++, 1));
                offset = _skipRLPStrings(node, offset, nibble);
                (, uint256 length) = _readRLPString(node, offset);
                if (length == 0) foundLeaf = true;
                else rootHash = _readRLPBytes32(node, offset);
            } else {
                bytes32 pathPart;
                uint256 partNibbles;
                (pathPart, partNibbles, foundLeaf, offset) = _readHPString(node, offset);
                bytes32 pathExpected = _getNibbles(path, nibbles, partNibbles);
                nibbles += partNibbles;
                if (pathPart != pathExpected) {
                    foundLeaf = true;
                } else if (foundLeaf) {
                    require(nibbles == 64, "Proof path too short");
                    data = node;
                    (dataOffset, ) = _readRLPString(data, offset);
                } else {
                    rootHash = _readRLPBytes32(node, offset);
                }
            }
        }
        require(nibbles <= 64, "Proof path too long");
        require(foundLeaf, "Incomplete proof");
    }

    function _isBranch(bytes memory node, uint256 offset) private pure returns (bool) {
        // If there are more than 2 elements, the node must be a branch
        offset = _skipRLPStrings(node, offset, 2);
        return node.length > offset;
    }

    function _readHPString(bytes memory data, uint256 offset)
        private
        pure
        returns (
            bytes32 nibbles,
            uint256 nibbleCount,
            bool isLeaf,
            uint256 nextOffset
        )
    {
        uint256 length;
        (offset, length) = _readRLPString(data, offset);
        require(length > 0, "Zero bytes HP string");
        // require(length < 34, "HP string too long");
        nextOffset = offset + length;

        bytes1 header = data[offset];
        require(header >> 6 == 0, "Invalid HP header");
        isLeaf = header & 0x20 != 0;
        bool isOddLength = header & 0x10 != 0;

        nibbleCount = (length - 1) * 2;
        nibbles = _readBytes(data, offset + 1, length - 1);
        if (isOddLength) {
            nibbleCount++;
            nibbles = (header << 4) | (nibbles >> 4);
        }
        nibbles = _getNibbles(nibbles, 0, nibbleCount);
    }

    function _getNibbles(
        bytes32 value,
        uint256 start,
        uint256 count
    ) private pure returns (bytes32 nibbles) {
        return (value << (start * 4)) >> ((64 - count) * 4);
    }

    function _readRLPList(bytes memory data, uint256 offset) private pure returns (uint256 start) {
        uint8 header = uint8(data[offset]);
        require(header > 191, "Expected an RLP list");
        if (header < 248) return offset + 1;
        uint256 lengthSize = header - 247;
        start = offset + 1 + lengthSize;
    }

    function _skipRLPStrings(
        bytes memory data,
        uint256 offset,
        uint256 items
    ) private pure returns (uint256 start) {
        for (uint256 i = 0; i < items; i++) {
            uint256 length;
            (offset, length) = _readRLPString(data, offset);
            offset += length;
        }
        return offset;
    }

    function _readRLPString(bytes memory data, uint256 offset)
        private
        pure
        returns (uint256 start, uint256 length)
    {
        uint8 header = uint8(data[offset]);
        if (header < 128) (start, length) = (offset, 1);
        else if (header < 184) (start, length) = (offset + 1, header - 128);
        else if (header < 192) {
            uint256 lengthSize = header - 183;
            length = _readInteger(data, offset + 1, lengthSize);
            start = offset + 1 + lengthSize;
        } else revert("Expected an RLP string");
        require(start + length <= data.length, "Unexpected end of RLP");
    }

    function _readRLPBytes32(bytes memory data, uint256 offset) private pure returns (bytes32) {
        (uint256 start, uint256 length) = _readRLPString(data, offset);
        require(length == 32, "Expected a 32-byte RLP string");
        return _readBytes(data, start, 32);
    }

    function _readBytes(
        bytes memory data,
        uint256 offset,
        uint256 sizeBytes
    ) private pure returns (bytes32) {
        return bytes32(_readInteger(data, offset, sizeBytes)) << ((32 - sizeBytes) * 8);
    }

    function _readInteger(
        bytes memory data,
        uint256 offset,
        uint256 sizeBytes
    ) private pure returns (uint256) {
        require(sizeBytes <= 32, "Read value too long");
        require(offset + sizeBytes <= data.length, "Unexpected end of data");
        return uint256(_readBytes32Raw(data, offset)) >> ((32 - sizeBytes) * 8);
    }

    function _readBytes32Raw(bytes memory data, uint256 offset)
        private
        pure
        returns (bytes32 value)
    {
        // solhint-disable-next-line no-inline-assembly
        assembly {
            value := mload(add(data, add(32, offset)))
        }
    }
}
