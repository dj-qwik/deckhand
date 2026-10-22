// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {DeckhandEscrow} from "../src/DeckhandEscrow.sol";

// Minimal cheatcode interface (no forge-std dependency).
interface Vm {
    function warp(uint256) external;
    function deal(address, uint256) external;
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function expectRevert(bytes4) external;
    function expectRevert() external;
    function addr(uint256) external returns (address);
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
    function chainId(uint256) external;
}

contract Rejecter {
    receive() external payable {
        revert("no");
    }

    function dep(DeckhandEscrow e, bytes32 id, uint64 exp, bytes calldata p) external payable {
        e.deposit{value: msg.value}(id, exp, p);
    }

    function pull(DeckhandEscrow e) external {
        e.withdrawOwed();
    }
}

contract DeckhandEscrowTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    DeckhandEscrow esc;
    uint256 constant OP_PK = 0xA11CE;
    uint256 constant CA_PK = 0xC0A;
    uint256 constant CB_PK = 0xC0B;
    uint256 constant CC_PK = 0xC0C;
    address op;
    address ca;
    address cb;
    address cc;
    address owner = address(0x9944eaEf8197ee5604C1063c525c71DE5D501a1D);
    address[4] players;
    uint128 constant ENTRY = 0.001 ether;
    bytes32 constant ID = keccak256("match-1");

    function setUp() public {
        op = vm.addr(OP_PK);
        ca = vm.addr(CA_PK);
        cb = vm.addr(CB_PK);
        cc = vm.addr(CC_PK);
        address[] memory cos = new address[](3);
        cos[0] = ca;
        cos[1] = cb;
        cos[2] = cc;
        vm.warp(1_000_000);
        vm.prank(op);
        esc = new DeckhandEscrow(op, cos, 2, owner, owner, owner, 1 ether);
        for (uint256 i = 0; i < 4; i++) {
            players[i] = vm.addr(1000 + i);
            vm.deal(players[i], 1 ether);
        }
    }

    // ---------------------------------------------------------------- helpers
    function _sig(uint256 pk, bytes32 digest) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _permit(bytes32 id, address p, uint64 exp) internal returns (bytes memory) {
        return _sig(OP_PK, esc.joinDigest(id, p, exp));
    }

    function _create(bytes32 id, uint8 seats) internal {
        vm.prank(op);
        esc.createMatch(id, ENTRY, seats, uint64(block.timestamp + 600));
    }

    function _join(bytes32 id, uint256 i) internal {
        uint64 exp = uint64(block.timestamp + 300);
        bytes memory p = _permit(id, players[i], exp);
        vm.prank(players[i]);
        esc.deposit{value: ENTRY}(id, exp, p);
    }

    function _sorted2(bytes32 digest, uint256 pk1, uint256 pk2) internal returns (bytes[] memory sigs) {
        sigs = new bytes[](2);
        address a1 = vm.addr(pk1);
        address a2 = vm.addr(pk2);
        if (uint160(a1) < uint160(a2)) {
            sigs[0] = _sig(pk1, digest);
            sigs[1] = _sig(pk2, digest);
        } else {
            sigs[0] = _sig(pk2, digest);
            sigs[1] = _sig(pk1, digest);
        }
    }

    function _status(bytes32 id) internal view returns (DeckhandEscrow.Status s) {
        (,,,,, s) = esc.matches(id);
    }

    function _eq(uint256 a, uint256 b, string memory what) internal pure {
        require(a == b, what);
    }

    // ------------------------------------------------------------------ tests
    function test_fullMatch_4p_pays_90_10() public {
        _create(ID, 4);
        for (uint256 i = 0; i < 4; i++) _join(ID, i);
        require(_status(ID) == DeckhandEscrow.Status.Locked, "locked");
        bytes32 rh = keccak256("state");
        bytes[] memory sigs = _sorted2(esc.resultDigest(ID, players[2], rh), CA_PK, CC_PK);
        uint256 w0 = players[2].balance;
        uint256 t0 = owner.balance;
        esc.submitResult(ID, players[2], rh, sigs);
        _eq(players[2].balance - w0, 0.0036 ether, "winner 90%");
        _eq(owner.balance - t0, 0.0004 ether, "house 10%");
        _eq(address(esc).balance, 0, "empty");
        require(_status(ID) == DeckhandEscrow.Status.Settled, "settled");
    }

    function test_rounding_remainder_goes_to_house() public {
        vm.prank(op);
        esc.createMatch(ID, 333, 3, uint64(block.timestamp + 600));
        for (uint256 i = 0; i < 3; i++) {
            uint64 exp = uint64(block.timestamp + 300);
            bytes memory p = _permit(ID, players[i], exp);
            vm.prank(players[i]);
            esc.deposit{value: 333}(ID, exp, p);
        }
        bytes32 rh = keccak256("s");
        uint256 w0 = players[0].balance;
        uint256 t0 = owner.balance;
        esc.submitResult(ID, players[0], rh, _sorted2(esc.resultDigest(ID, players[0], rh), CA_PK, CB_PK));
        _eq(players[0].balance - w0, 899, "floor(999*90/100)");
        _eq(owner.balance - t0, 100, "remainder");
    }

    function test_double_settle_rejected() public {
        _create(ID, 2);
        _join(ID, 0);
        _join(ID, 1);
        bytes32 rh = keccak256("s");
        bytes[] memory sigs = _sorted2(esc.resultDigest(ID, players[0], rh), CA_PK, CB_PK);
        esc.submitResult(ID, players[0], rh, sigs);
        vm.expectRevert(DeckhandEscrow.BadStatus.selector);
        esc.submitResult(ID, players[0], rh, sigs);
    }

    function test_one_cosigner_not_enough() public {
        _create(ID, 2);
        _join(ID, 0);
        _join(ID, 1);
        bytes32 rh = keccak256("s");
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = _sig(CA_PK, esc.resultDigest(ID, players[0], rh));
        vm.expectRevert(DeckhandEscrow.BadSignature.selector);
        esc.submitResult(ID, players[0], rh, sigs);
    }

    function test_duplicate_cosigner_rejected() public {
        _create(ID, 2);
        _join(ID, 0);
        _join(ID, 1);
        bytes32 rh = keccak256("s");
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _sig(CA_PK, esc.resultDigest(ID, players[0], rh));
        sigs[1] = sigs[0];
        vm.expectRevert(DeckhandEscrow.BadSignature.selector);
        esc.submitResult(ID, players[0], rh, sigs);
    }

    function test_operator_is_not_a_cosigner() public {
        _create(ID, 2);
        _join(ID, 0);
        _join(ID, 1);
        bytes32 rh = keccak256("s");
        bytes[] memory sigs = _sorted2(esc.resultDigest(ID, players[0], rh), CA_PK, OP_PK);
        vm.expectRevert(DeckhandEscrow.BadSignature.selector);
        esc.submitResult(ID, players[0], rh, sigs);
    }

    function test_wrong_winner_signature_rejected() public {
        _create(ID, 2);
        _join(ID, 0);
        _join(ID, 1);
        bytes32 rh = keccak256("s");
        bytes[] memory sigs = _sorted2(esc.resultDigest(ID, players[0], rh), CA_PK, CB_PK);
        vm.expectRevert(DeckhandEscrow.BadSignature.selector);
        esc.submitResult(ID, players[1], rh, sigs);
    }

    function test_winner_must_be_player() public {
        _create(ID, 2);
        _join(ID, 0);
        _join(ID, 1);
        bytes32 rh = keccak256("s");
        bytes[] memory sigs = _sorted2(esc.resultDigest(ID, players[3], rh), CA_PK, CB_PK);
        vm.expectRevert(DeckhandEscrow.NotAPlayer.selector);
        esc.submitResult(ID, players[3], rh, sigs);
    }

    function test_cannot_settle_unlocked() public {
        _create(ID, 3);
        _join(ID, 0);
        _join(ID, 1);
        bytes32 rh = keccak256("s");
        bytes[] memory sigs = _sorted2(esc.resultDigest(ID, players[0], rh), CA_PK, CB_PK);
        vm.expectRevert(DeckhandEscrow.BadStatus.selector);
        esc.submitResult(ID, players[0], rh, sigs);
    }

    function test_signature_bound_to_chain() public {
        _create(ID, 2);
        _join(ID, 0);
        _join(ID, 1);
        bytes32 rh = keccak256("s");
        bytes[] memory sigs = _sorted2(esc.resultDigest(ID, players[0], rh), CA_PK, CB_PK);
        vm.chainId(46630);
        vm.expectRevert(DeckhandEscrow.BadSignature.selector);
        esc.submitResult(ID, players[0], rh, sigs);
    }

    function test_deposit_needs_operator_permit() public {
        _create(ID, 2);
        uint64 exp = uint64(block.timestamp + 300);
        bytes memory p = _sig(CA_PK, esc.joinDigest(ID, players[0], exp));
        vm.prank(players[0]);
        vm.expectRevert(DeckhandEscrow.BadSignature.selector);
        esc.deposit{value: ENTRY}(ID, exp, p);
        // permit for someone else can't be reused
        bytes memory p2 = _permit(ID, players[1], exp);
        vm.prank(players[0]);
        vm.expectRevert(DeckhandEscrow.BadSignature.selector);
        esc.deposit{value: ENTRY}(ID, exp, p2);
    }

    function test_deposit_rules() public {
        _create(ID, 2);
        uint64 exp = uint64(block.timestamp + 300);
        bytes memory p = _permit(ID, players[0], exp);
        vm.prank(players[0]);
        vm.expectRevert(DeckhandEscrow.WrongValue.selector);
        esc.deposit{value: ENTRY - 1}(ID, exp, p);
        vm.prank(players[0]);
        esc.deposit{value: ENTRY}(ID, exp, p);
        vm.prank(players[0]);
        vm.expectRevert(DeckhandEscrow.AlreadyJoined.selector);
        esc.deposit{value: ENTRY}(ID, exp, p);
        _join(ID, 1);
        // locked now: third player cannot join
        bytes memory p3 = _permit(ID, players[2], exp);
        vm.prank(players[2]);
        vm.expectRevert(DeckhandEscrow.BadStatus.selector);
        esc.deposit{value: ENTRY}(ID, exp, p3);
    }

    function test_late_deposit_rejected() public {
        _create(ID, 2);
        uint64 exp = uint64(block.timestamp + 3000);
        bytes memory p = _permit(ID, players[0], exp);
        vm.warp(block.timestamp + 601);
        vm.prank(players[0]);
        vm.expectRevert(DeckhandEscrow.Expired.selector);
        esc.deposit{value: ENTRY}(ID, exp, p);
    }

    function test_unfilled_lobby_refund_by_anyone() public {
        _create(ID, 4);
        _join(ID, 0);
        _join(ID, 1);
        uint256 b0 = players[0].balance;
        vm.expectRevert(DeckhandEscrow.TooEarly.selector);
        esc.refundExpired(ID);
        vm.warp(block.timestamp + 601);
        esc.refundExpired(ID);
        _eq(players[0].balance - b0, ENTRY, "refunded");
        _eq(address(esc).balance, 0, "empty");
        require(_status(ID) == DeckhandEscrow.Status.Refunded, "refunded status");
    }

    function test_locked_match_refundable_after_max_play() public {
        _create(ID, 2);
        _join(ID, 0);
        _join(ID, 1);
        vm.warp(block.timestamp + 1 hours);
        vm.expectRevert(DeckhandEscrow.TooEarly.selector);
        esc.refundExpired(ID);
        vm.warp(block.timestamp + 1 hours + 1);
        esc.refundExpired(ID);
        _eq(address(esc).balance, 0, "empty");
    }

    function test_operator_and_guardian_can_cancel_but_not_strangers() public {
        _create(ID, 2);
        _join(ID, 0);
        vm.prank(players[3]);
        vm.expectRevert(DeckhandEscrow.NotAuthorized.selector);
        esc.cancel(ID);
        vm.prank(owner);
        esc.cancel(ID);
        _eq(address(esc).balance, 0, "empty");
        bytes32 id2 = keccak256("m2");
        _create(id2, 2);
        _join(id2, 0);
        _join(id2, 1);
        vm.prank(op);
        esc.cancel(id2);
        _eq(address(esc).balance, 0, "empty2");
        vm.prank(op);
        vm.expectRevert(DeckhandEscrow.BadStatus.selector);
        esc.cancel(id2);
    }

    function test_failed_push_becomes_owed() public {
        Rejecter r = new Rejecter();
        vm.deal(address(r), 1 ether);
        _create(ID, 2);
        uint64 exp = uint64(block.timestamp + 300);
        r.dep{value: ENTRY}(esc, ID, exp, _permit(ID, address(r), exp));
        _join(ID, 0);
        bytes32 rh = keccak256("s");
        esc.submitResult(ID, address(r), rh, _sorted2(esc.resultDigest(ID, address(r), rh), CA_PK, CB_PK));
        _eq(esc.owed(address(r)), 0.0018 ether, "owed");
        _eq(address(esc).balance, 0.0018 ether, "held");
    }

    function test_only_operator_creates_and_pause() public {
        vm.prank(players[0]);
        vm.expectRevert(DeckhandEscrow.NotAuthorized.selector);
        esc.createMatch(ID, ENTRY, 2, uint64(block.timestamp + 60));
        vm.prank(owner);
        esc.setPaused(true);
        vm.prank(op);
        vm.expectRevert(DeckhandEscrow.IsPaused.selector);
        esc.createMatch(ID, ENTRY, 2, uint64(block.timestamp + 60));
    }

    function test_entry_cap_and_seat_bounds() public {
        vm.startPrank(op);
        vm.expectRevert(DeckhandEscrow.BadParams.selector);
        esc.createMatch(ID, 2 ether, 2, uint64(block.timestamp + 60));
        vm.expectRevert(DeckhandEscrow.BadParams.selector);
        esc.createMatch(ID, ENTRY, 5, uint64(block.timestamp + 60));
        vm.expectRevert(DeckhandEscrow.BadParams.selector);
        esc.createMatch(ID, ENTRY, 1, uint64(block.timestamp + 60));
        vm.expectRevert(DeckhandEscrow.BadParams.selector);
        esc.createMatch(ID, ENTRY, 2, uint64(block.timestamp + 2 hours));
        vm.stopPrank();
    }

    function test_admin_transfer_needs_two_days() public {
        require(esc.admin() == op, "deployer admin");
        require(esc.pendingAdmin() == owner, "pending owner");
        vm.prank(owner);
        vm.expectRevert(DeckhandEscrow.TooEarly.selector);
        esc.acceptDefaultAdminTransfer();
        vm.warp(block.timestamp + 2 days);
        vm.prank(owner);
        esc.acceptDefaultAdminTransfer();
        require(esc.admin() == owner, "owner admin");
        vm.prank(op);
        vm.expectRevert(DeckhandEscrow.NotAuthorized.selector);
        esc.setTreasury(op);
    }
}
