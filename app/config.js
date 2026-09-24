// Networks Tollgate is deployed on. Pick one with ?net=<key>; Arc mainnet is the default.
export const DEFAULT_NET = 'arc'; // switch back to 'arc' once the Arc mainnet contract is deployed

export const NETWORKS = {
  arc: {
    label: 'Arc mainnet',
    chainId: 5042,
    name: 'Arc',
    native: { name: 'USDC', symbol: 'USDC', decimals: 18 },
    rpc: 'https://rpc.mainnet.arc.io',
    explorer: 'https://explorer.arc.io',
    contract: '0xEF2B3226f14Bd201bF90C3bc489ebE829b39483F',
    minFeeGwei: 25, // Arc drops transactions below its 20 gwei base-fee floor
    tokens: {
      USDC: { address: '0x3600000000000000000000000000000000000000', decimals: 6 },
      EURC: { address: '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1', decimals: 6 },
    },
  },
  'arbitrum-sepolia': {
    label: 'Arbitrum Sepolia',
    chainId: 421614,
    name: 'Arbitrum Sepolia',
    native: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpc: 'https://sepolia-rollup.arbitrum.io/rpc',
    explorer: 'https://sepolia.arbiscan.io',
    contract: '0xEF2B3226f14Bd201bF90C3bc489ebE829b39483F',
    minFeeGwei: 0,
    tokens: {
      USDG: { address: '0xFFC95faa3d63Cde504a05B567C600B78C0b41892', decimals: 6 },
      USDC: { address: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d', decimals: 6 },
    },
  },
};
