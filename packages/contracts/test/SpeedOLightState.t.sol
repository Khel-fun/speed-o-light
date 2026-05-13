// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../contracts/SpeedOLightState.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/**
 * @title SpeedOLightStateTest
 * @notice Test suite for SpeedOLightState contract
 */
contract SpeedOLightStateTest is Test {
    using MessageHashUtils for bytes32;

    event GameResultPublished(
        address indexed player,
        bytes32 indexed gameId,
        uint256 score,
        uint256 xpEarned,
        bool won
    );
    event ServerSignerUpdated(address indexed oldSigner, address indexed newSigner);

    SpeedOLightState public state;

    address public owner;
    address public serverSigner;
    address public player1;
    address public player2;

    bytes32 public gameId1;
    bytes32 public gameId2;

    constructor() {
        owner = address(this);
        serverSigner = makeAddr("serverSigner");
        player1 = makeAddr("player1");
        player2 = makeAddr("player2");

        gameId1 = keccak256("game1");
        gameId2 = keccak256("game2");

        state = new SpeedOLightState(serverSigner, owner);
    }

    // ============ Helper: Sign result ============

    function signResult(
        address player,
        bytes32 gameId,
        uint256 score,
        uint256 xp,
        bool won,
        uint256 privateKey
    ) internal pure returns (bytes memory) {
        bytes32 dataHash = keccak256(
            abi.encodePacked(gameId, player, score, xp, won)
        );
        bytes32 ethHash = dataHash.toEthSignedMessageHash();
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, ethHash);
        return abi.encodePacked(r, s, v);
    }

    // ============ Test: Publish Result ============

    function test_PublishResult() public {
        uint256 privateKey = 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef;
        address signer = vm.addr(privateKey);
        
        // Update server signer for test
        vm.prank(owner);
        state.setServerSigner(signer);

        uint256 score = 50;
        uint256 xp = 5000;
        bool won = true;

        bytes memory signature = signResult(player1, gameId1, score, xp, won, privateKey);

        vm.prank(player1);

        vm.expectEmit(true, false, false, true);
        emit GameResultPublished(player1, gameId1, score, xp, won);

        state.publishResult(gameId1, score, xp, won, signature);

        SpeedOLightState.PlayerStats memory stats = state.getPlayerStats(player1);
        assertEq(stats.totalXP, xp);
        assertEq(stats.gamesPlayed, 1);
        assertEq(stats.gamesWon, 1);
        assertEq(stats.bestScore, score);

        assertTrue(state.isGameProcessed(gameId1));
    }

    function test_PublishResult_MultipleGames() public {
        uint256 privateKey = 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef;
        address signer = vm.addr(privateKey);
        vm.prank(owner);
        state.setServerSigner(signer);

        // Game 1: Score 30, XP 3000, won
        vm.prank(player1);
        state.publishResult(
            gameId1,
            30,
            3000,
            true,
            signResult(player1, gameId1, 30, 3000, true, privateKey)
        );

        // Game 2: Score 50, XP 5000, won
        vm.prank(player1);
        state.publishResult(
            gameId2,
            50,
            5000,
            true,
            signResult(player1, gameId2, 50, 5000, true, privateKey)
        );

        SpeedOLightState.PlayerStats memory stats = state.getPlayerStats(player1);
        assertEq(stats.totalXP, 8000);
        assertEq(stats.gamesPlayed, 2);
        assertEq(stats.gamesWon, 2);
        assertEq(stats.bestScore, 50); // Higher score preserved
    }

    function test_PublishResult_Loss() public {
        uint256 privateKey = 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef;
        address signer = vm.addr(privateKey);
        vm.prank(owner);
        state.setServerSigner(signer);

        vm.prank(player1);
        state.publishResult(
            gameId1,
            20,
            2000,
            false,
            signResult(player1, gameId1, 20, 2000, false, privateKey)
        );

        SpeedOLightState.PlayerStats memory stats = state.getPlayerStats(player1);
        assertEq(stats.totalXP, 2000);
        assertEq(stats.gamesPlayed, 1);
        assertEq(stats.gamesWon, 0);
        assertEq(stats.bestScore, 20);
    }

    // ============ Test: Replay Protection ============

    function test_PublishResult_Revert_AlreadyProcessed() public {
        uint256 privateKey = 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef;
        address signer = vm.addr(privateKey);
        vm.prank(owner);
        state.setServerSigner(signer);

        vm.prank(player1);
        state.publishResult(
            gameId1,
            50,
            5000,
            true,
            signResult(player1, gameId1, 50, 5000, true, privateKey)
        );

        vm.prank(player1);
        vm.expectRevert(SpeedOLightState.GameAlreadyProcessed.selector);
        state.publishResult(
            gameId1,
            50,
            5000,
            true,
            signResult(player1, gameId1, 50, 5000, true, privateKey)
        );
    }

    // ============ Test: Signature Validation ============

    function test_PublishResult_Revert_InvalidSignature() public {
        uint256 privateKey = 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef;
        uint256 wrongKey = 0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef;
        
        vm.prank(player1);
        vm.expectRevert(SpeedOLightState.InvalidServerSignature.selector);
        state.publishResult(
            gameId1,
            50,
            5000,
            true,
            signResult(player1, gameId1, 50, 5000, true, wrongKey)
        );
    }

    // ============ Test: Admin Functions ============

    function test_SetServerSigner() public {
        address newSigner = makeAddr("newSigner");

        vm.prank(owner);

        vm.expectEmit(true, false, false, true);
        emit ServerSignerUpdated(serverSigner, newSigner);

        state.setServerSigner(newSigner);

        assertEq(state.serverSigner(), newSigner);
    }

    function test_SetServerSigner_Revert_ZeroAddress() public {
        vm.prank(owner);
        vm.expectRevert(SpeedOLightState.ZeroAddressSigner.selector);
        state.setServerSigner(address(0));
    }

    function test_SetServerSigner_Revert_NotOwner() public {
        vm.prank(player1);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, player1));
        state.setServerSigner(makeAddr("newSigner"));
    }

    // ============ Test: Leaderboard ============

    function test_Leaderboard_MultiplePlayers() public {
        uint256 privateKey = 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef;
        address signer = vm.addr(privateKey);
        vm.prank(owner);
        state.setServerSigner(signer);

        // Player 1: Score 50, XP 5000
        vm.prank(player1);
        state.publishResult(
            gameId1,
            50,
            5000,
            true,
            signResult(player1, gameId1, 50, 5000, true, privateKey)
        );

        // Player 2: Score 60, XP 6000 (better)
        vm.prank(player2);
        state.publishResult(
            gameId2,
            60,
            6000,
            true,
            signResult(player2, gameId2, 60, 6000, true, privateKey)
        );

        SpeedOLightState.LeaderboardEntry[] memory leaderboard = state.getLeaderboard();
        assertEq(leaderboard.length, 2);

        // Player 2 should be first (higher score)
        assertEq(leaderboard[0].player, player2);
        assertEq(leaderboard[0].bestScore, 60);
    }

    // ============ Test: View Functions ============

    function test_GetTopPlayers() public {
        uint256 privateKey = 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef;
        address signer = vm.addr(privateKey);
        vm.prank(owner);
        state.setServerSigner(signer);

        vm.prank(player1);
        state.publishResult(gameId1, 50, 5000, true, signResult(player1, gameId1, 50, 5000, true, privateKey));

        SpeedOLightState.LeaderboardEntry[] memory top = state.getTopPlayers(1);
        assertEq(top.length, 1);
        assertEq(top[0].player, player1);
    }
}
