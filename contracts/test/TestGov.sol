//SPDX-License-Identifier: GPL-3.0-only
//solhint-disable not-rely-on-time

pragma solidity ^0.8.14;

import {TestERC20} from "./TestERC20.sol";
import {SnapshopLib} from "../SnapshopLib.sol";

struct Proposal {
    uint256 blockNumber;
    uint256 endTimestamp;
    bytes32 storageRoot;
    uint256 votesFor;
    uint256 votesAgainst;
    mapping(address => bool) casted;
}

contract TestGov {
    TestERC20 public immutable erc20;
    uint256 public immutable voteTime;
    uint256 public nextProposalId;
    mapping(uint256 => Proposal) public proposals;

    constructor(TestERC20 _erc20, uint256 _voteTime) {
        erc20 = _erc20;
        voteTime = _voteTime;
    }

    /// @param header The header of the block to use for proposal.
    /// For mainnet must be no older than 256 blocks or about 1 hour.
    /// @param proof The account storage proof for `erc20` on the `blockNumber` block.
    function createProposal(bytes memory header, bytes[] memory proof) public {
        (uint256 blockNumber, bytes32 stateRoot) = SnapshopLib.blockStateRoot(header);
        bytes32 storageRoot = SnapshopLib.accountStorageRoot(stateRoot, address(erc20), proof);
        Proposal storage proposal = proposals[nextProposalId++];
        proposal.blockNumber = blockNumber;
        proposal.endTimestamp = block.timestamp + voteTime;
        proposal.storageRoot = storageRoot;
    }

    /// @param proof The storage proof of `msg.sender`'s balance in `erc20` on the proposal's block.
    function castVote(
        uint256 proposalId,
        bool voteFor,
        bytes[] memory proof
    ) public {
        Proposal storage proposal = proposals[proposalId];
        uint256 endTimestamp = proposal.endTimestamp;
        require(endTimestamp != 0, "Invalid proposal ID");
        require(block.timestamp < endTimestamp, "Voting finished");
        require(proposal.casted[msg.sender] == false, "Already voted");
        uint256 balancesRoot = 1;
        uint256 balancesKey = uint160(address(msg.sender));
        bytes32 slot = keccak256(abi.encodePacked(balancesKey, balancesRoot));
        uint256 balance = uint256(SnapshopLib.storageValue(proposal.storageRoot, slot, proof));
        proposal.casted[msg.sender] = true;
        if (voteFor) proposal.votesFor += balance;
        else proposal.votesAgainst += balance;
    }

    function proposalPassed(uint256 proposalId) public view returns (bool) {
        Proposal storage proposal = proposals[proposalId];
        uint256 endTimestamp = proposal.endTimestamp;
        require(endTimestamp != 0, "Invalid proposal ID");
        require(block.timestamp >= endTimestamp, "Voting in progress");
        return proposal.votesFor > proposal.votesAgainst;
    }
}
