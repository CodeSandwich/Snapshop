require("@nomiclabs/hardhat-waffle");

// @type import('hardhat/config').HardhatUserConfig
module.exports = {
  solidity: {
    version: "0.8.14",
    settings: {
      optimizer: {
        enabled: true,
        runs: 1000000
      }
    }
  },
  defaultNetwork: "gethDev",
  networks: {
    gethDev: {
      url: "http://127.0.0.1:8545"
    }
  }
};
