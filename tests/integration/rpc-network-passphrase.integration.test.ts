import { Keypair } from '@stellar/stellar-sdk';
import { CoralSwapClient } from '../../src/client';
import { NetworkMismatchError } from '../../src/errors';
import { NETWORK_CONFIGS, STAGING_NETWORK } from '../../src/config';
import { Network } from '../../src/types/common';

const FUTURENET_PUBLIC_RPC = STAGING_NETWORK.rpcUrl; // https://rpc-futurenet.stellar.org

describe('Integration: RPC network passphrase verification (#866)', () => {
  it('rejects a TESTNET client pointed at the public Futurenet RPC with NetworkMismatchError', async () => {
    const keypair = Keypair.random();
    const client = new CoralSwapClient({
      network: Network.TESTNET,
      secretKey: keypair.secret(),
      rpcUrl: FUTURENET_PUBLIC_RPC,
      maxRetries: 1,
      retryDelayMs: 250,
    });

    let caught: unknown;
    try {
      await client.getAccount(keypair.publicKey());
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(NetworkMismatchError);
    const mismatch = caught as NetworkMismatchError;
    expect(mismatch.code).toBe('NETWORK_MISMATCH');
    expect(mismatch.expectedPassphrase).toBe(NETWORK_CONFIGS[Network.TESTNET].networkPassphrase);
    expect(mismatch.actualPassphrase).toBe(STAGING_NETWORK.networkPassphrase);
    expect(mismatch.rpcUrl).toBe(FUTURENET_PUBLIC_RPC);
  });

  it('fails eagerly via verifyEndpoints() when a TESTNET client points at the public Futurenet RPC', async () => {
    const client = new CoralSwapClient({
      network: Network.TESTNET,
      rpcUrl: FUTURENET_PUBLIC_RPC,
    });

    await expect(client.verifyEndpoints()).rejects.toThrow(NetworkMismatchError);
  });
});
