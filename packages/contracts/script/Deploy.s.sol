// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../contracts/SpeedOLightState.sol";

/**
 * @title Deploy
 * @notice Foundry deployment script for SpeedOLightState
 */
contract DeployScript is Script {
    function run() external {
        // Load private key and server signer from environment
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        address serverSigner = vm.envOr("SERVER_SIGNER", deployer);

        console.log("Deploying SpeedOLightState...");
        console.log("Deployer:", deployer);
        console.log("Server Signer:", serverSigner);

        vm.startBroadcast(deployerPrivateKey);

        // Deploy contract
        SpeedOLightState game = new SpeedOLightState(serverSigner, deployer);

        vm.stopBroadcast();

        // Log deployment info
        console.log("Deployment complete!");
        console.log("Contract:", address(game));
        console.log("Owner:", deployer);
        console.log("Server Signer:", serverSigner);
    }
}
