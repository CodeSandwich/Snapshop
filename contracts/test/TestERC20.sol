//SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.14;

contract TestERC20 {
    // solhint-disable const-name-snakecase
    string public constant name = "Test ERC20";
    string public constant symbol = "TERC";
    uint8 public constant decimals = 18;
    // solhint-enable const-name-snakecase

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 amt);
    event Approval(address indexed owner, address indexed spender, uint256 amt);

    function mint(address owner, uint256 amt) public {
        totalSupply += amt;
        balanceOf[owner] = amt;
    }

    function transfer(address to, uint256 amt) public returns (bool) {
        _transfer(msg.sender, to, amt);
        return true;
    }

    function transferFrom(
        address from,
        address to,
        uint256 amt
    ) public returns (bool) {
        require(allowance[from][to] >= amt, "Insufficient allowance");
        allowance[from][to] -= amt;
        _transfer(from, to, amt);
        return true;
    }

    function approve(address spender, uint256 amt) public returns (bool) {
        allowance[msg.sender][spender] = amt;
        emit Approval(msg.sender, spender, amt);
        return true;
    }

    function _transfer(
        address from,
        address to,
        uint256 amt
    ) internal {
        require(balanceOf[from] >= amt, "Insufficient balance");
        balanceOf[from] -= amt;
        balanceOf[to] += amt;
        emit Transfer(from, to, amt);
    }
}
