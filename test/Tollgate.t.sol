// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Tollgate, IERC20} from "../src/Tollgate.sol";

contract MockUSDC {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract TollgateTest is Test {
    Tollgate tg;
    MockUSDC usdc;
    address payer = makeAddr("payer");
    address provider = makeAddr("provider");
    uint256 sessionKey = 0xA11CE;
    address session;
    uint64 constant GRACE = 1 hours;

    function setUp() public {
        vm.warp(1_790_000_000);
        tg = new Tollgate();
        usdc = new MockUSDC();
        session = vm.addr(sessionKey);
        usdc.mint(payer, 1_000e6);
        vm.prank(payer);
        usdc.approve(address(tg), type(uint256).max);
    }

    function _open(uint128 amount) internal returns (bytes32 id) {
        vm.prank(payer);
        id = tg.open(provider, session, IERC20(address(usdc)), amount, GRACE);
    }

    function _sign(uint256 key, bytes32 id, uint256 cumulative) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, tg.voucherDigest(id, cumulative));
        return abi.encodePacked(r, s, v);
    }

    function _state(bytes32 id) internal view returns (uint128 deposit, uint128 redeemed, uint64 closeAt, bool closed) {
        (,,,, deposit, redeemed,, closeAt, closed) = tg.channels(id);
    }

    // ------------------------------------------------------------------ open

    function test_open_locksDeposit() public {
        bytes32 id = _open(10e6);
        assertEq(usdc.balanceOf(address(tg)), 10e6);
        (address p, address pr, address s,,,,,,) = tg.channels(id);
        assertEq(p, payer);
        assertEq(pr, provider);
        assertEq(s, session);
        assertEq(tg.available(id), 10e6);
        assertEq(tg.nonces(payer), 1);
        assertTrue(_open(1e6) != id, "each channel gets a fresh id");
    }

    function test_open_rejectsBadParams() public {
        IERC20 t = IERC20(address(usdc));
        vm.startPrank(payer);
        vm.expectRevert(Tollgate.InvalidParams.selector);
        tg.open(payer, session, t, 1e6, GRACE); // provider == payer
        vm.expectRevert(Tollgate.InvalidParams.selector);
        tg.open(provider, address(0), t, 1e6, GRACE);
        vm.expectRevert(Tollgate.InvalidParams.selector);
        tg.open(provider, session, t, 0, GRACE);
        vm.expectRevert(Tollgate.InvalidParams.selector);
        tg.open(provider, session, t, 1e6, 1 minutes);
        vm.expectRevert(Tollgate.InvalidParams.selector);
        tg.open(provider, session, t, 1e6, 8 days);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- redeem

    function test_redeem_paysOnlyTheIncrement() public {
        bytes32 id = _open(10e6);
        tg.redeem(id, 1_500, _sign(sessionKey, id, 1_500)); // anyone can submit
        assertEq(usdc.balanceOf(provider), 1_500);
        tg.redeem(id, 4_000, _sign(sessionKey, id, 4_000));
        assertEq(usdc.balanceOf(provider), 4_000);
        (, uint128 redeemed,,) = _state(id);
        assertEq(redeemed, 4_000);
    }

    function test_redeem_rejectsReplayAndOlderVouchers() public {
        bytes32 id = _open(10e6);
        bytes memory v2 = _sign(sessionKey, id, 2_000);
        bytes memory v1 = _sign(sessionKey, id, 1_000);
        tg.redeem(id, 2_000, v2);
        vm.expectRevert(Tollgate.NotIncreasing.selector);
        tg.redeem(id, 2_000, v2);
        vm.expectRevert(Tollgate.NotIncreasing.selector);
        tg.redeem(id, 1_000, v1);
    }

    function test_redeem_rejectsOverDepositWrongSignerAndOtherChannel() public {
        bytes32 id = _open(10e6);
        bytes32 other = _open(10e6);
        bytes memory over = _sign(sessionKey, id, 10e6 + 1);
        bytes memory wrongKey = _sign(0xB0B, id, 1_000);
        bytes memory otherChannel = _sign(sessionKey, other, 1_000);
        vm.expectRevert(Tollgate.ExceedsDeposit.selector);
        tg.redeem(id, 10e6 + 1, over);
        vm.expectRevert(Tollgate.BadSignature.selector);
        tg.redeem(id, 1_000, wrongKey);
        vm.expectRevert(Tollgate.BadSignature.selector); // voucher for another channel
        tg.redeem(id, 1_000, otherChannel);
        vm.expectRevert(Tollgate.BadSignature.selector);
        tg.redeem(id, 1_000, hex"1234");
    }

    function test_redeem_rejectsMalleableSignature() public {
        bytes32 id = _open(10e6);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(sessionKey, tg.voucherDigest(id, 1_000));
        uint256 n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141;
        bytes32 sHigh = bytes32(n - uint256(s));
        uint8 vFlip = v == 27 ? 28 : 27;
        vm.expectRevert(Tollgate.BadSignature.selector);
        tg.redeem(id, 1_000, abi.encodePacked(r, sHigh, vFlip));
    }

    function test_voucherBoundToThisContract() public {
        bytes32 id = _open(10e6);
        Tollgate other = new Tollgate();
        assertTrue(other.voucherDigest(id, 1_000) != tg.voucherDigest(id, 1_000));
    }

    // ----------------------------------------------------------------- close

    function test_closeFlow_providerCanRedeemDuringGrace() public {
        bytes32 id = _open(10e6);
        bytes memory v = _sign(sessionKey, id, 3e6);
        vm.prank(payer);
        tg.requestClose(id);

        vm.prank(payer);
        vm.expectRevert(Tollgate.TooEarly.selector);
        tg.finalizeClose(id);

        vm.warp(block.timestamp + GRACE - 1);
        tg.redeem(id, 3e6, v); // provider still gets paid inside the grace window

        vm.warp(block.timestamp + 1);
        vm.prank(payer);
        tg.finalizeClose(id);
        assertEq(usdc.balanceOf(provider), 3e6);
        assertEq(usdc.balanceOf(payer), 1_000e6 - 3e6);
        assertEq(tg.available(id), 0);

        bytes memory late = _sign(sessionKey, id, 4e6);
        vm.expectRevert(Tollgate.ChannelClosed.selector);
        tg.redeem(id, 4e6, late);
    }

    function test_topUpCancelsCloseRequest() public {
        bytes32 id = _open(10e6);
        vm.prank(payer);
        tg.requestClose(id);
        vm.prank(payer);
        tg.topUp(id, 5e6);
        (uint128 deposit,, uint64 closeAt,) = _state(id);
        assertEq(deposit, 15e6);
        assertEq(closeAt, 0);
        vm.warp(block.timestamp + GRACE);
        vm.prank(payer);
        vm.expectRevert(Tollgate.TooEarly.selector);
        tg.finalizeClose(id);
    }

    function test_closeByProvider_withFinalVoucher() public {
        bytes32 id = _open(10e6);
        tg.redeem(id, 1e6, _sign(sessionKey, id, 1e6));
        bytes memory last = _sign(sessionKey, id, 2_500_000);
        vm.prank(payer);
        vm.expectRevert(Tollgate.NotProvider.selector);
        tg.closeByProvider(id, 2_500_000, last);
        vm.prank(provider);
        tg.closeByProvider(id, 2_500_000, last);
        assertEq(usdc.balanceOf(provider), 2_500_000);
        assertEq(usdc.balanceOf(payer), 1_000e6 - 2_500_000);
    }

    function test_closeByProvider_withoutVoucher() public {
        bytes32 id = _open(10e6);
        vm.prank(provider);
        tg.closeByProvider(id, 0, "");
        assertEq(usdc.balanceOf(payer), 1_000e6);
    }

    function test_onlyPayerManagesChannel() public {
        bytes32 id = _open(10e6);
        vm.expectRevert(Tollgate.NotPayer.selector);
        tg.topUp(id, 1);
        vm.expectRevert(Tollgate.NotPayer.selector);
        tg.requestClose(id);
        vm.expectRevert(Tollgate.NotPayer.selector);
        tg.finalizeClose(id);
    }

    // ------------------------------------------------------------ invariants

    /// Any sequence of vouchers followed by either kind of close leaves nothing in the contract,
    /// and the provider receives exactly the highest voucher it redeemed.
    function testFuzz_conservation(uint128 deposit, uint128 a, uint128 b, bool providerCloses) public {
        deposit = uint128(bound(deposit, 2, 1_000e6));
        a = uint128(bound(a, 1, deposit - 1));
        b = uint128(bound(b, a + 1, deposit));
        bytes32 id = _open(deposit);
        tg.redeem(id, a, _sign(sessionKey, id, a));
        bytes memory vb = _sign(sessionKey, id, b);
        if (providerCloses) {
            vm.prank(provider);
            tg.closeByProvider(id, b, vb);
        } else {
            tg.redeem(id, b, vb);
            vm.prank(payer);
            tg.requestClose(id);
            vm.warp(block.timestamp + GRACE);
            vm.prank(payer);
            tg.finalizeClose(id);
        }
        assertEq(usdc.balanceOf(address(tg)), 0);
        assertEq(usdc.balanceOf(provider), b);
        assertEq(usdc.balanceOf(payer), 1_000e6 - b);
    }
}
