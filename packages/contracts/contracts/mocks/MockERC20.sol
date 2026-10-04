// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title MockERC20
 * @notice Minimal mintable ERC20 standing in for a Hedera native (HTS) token in tests.
 * @dev On a real network the grant token is created with `TokenCreateTransaction` through
 *      the Hedera SDK, which yields an HTS entity that already implements this interface.
 *      This mock exists purely so the contract suite can run offline on the Hardhat
 *      in-process network.
 */
contract MockERC20 {
    string public name;
    string public symbol;
    uint8 public immutable decimals;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    error InsufficientBalance();
    error InsufficientAllowance();
    error TransferFailed();

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(
        address indexed owner,
        address indexed spender,
        uint256 value
    );

    constructor(string memory name_, string memory symbol_, uint8 decimals_) {
        name = name_;
        symbol = symbol_;
        decimals = decimals_;
    }

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    /**
     * @notice Ledger-privileged allowance write, standing in for the HTS system contract.
     * @dev On Hedera the token service is not the token owner. When a contract calls HTS
     *      `approve(token, spender, amount)`, the ledger records an allowance from the
     *      *calling account*, not from the token service. A plain ERC20 cannot express that,
     *      which is exactly why this function exists on the mock.
     * @param owner Account the allowance belongs to, i.e. the HTS caller.
     * @param spender Account being granted the allowance.
     * @param amount Allowance in the token's smallest unit.
     */
    function setAllowanceBySystem(
        address owner,
        address spender,
        uint256 amount
    ) external {
        allowance[owner][spender] = amount;
        emit Approval(owner, spender, amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (balanceOf[msg.sender] < amount) revert InsufficientBalance();
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(
        address from,
        address to,
        uint256 amount
    ) external returns (bool) {
        if (balanceOf[from] < amount) revert InsufficientBalance();
        if (from != msg.sender) {
            uint256 allowed = allowance[from][msg.sender];
            if (allowed < amount) revert InsufficientAllowance();
            if (allowed != type(uint256).max) {
                allowance[from][msg.sender] = allowed - amount;
            }
        }
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}
