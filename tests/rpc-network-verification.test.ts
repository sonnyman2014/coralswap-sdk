import { Keypair, rpc, xdr } from '@stellar/stellar-sdk';
import { CoralSwapClient } from '../src/client';
import { NetworkMismatchError, CoralSwapSDKError } from '../src/errors';
import { NETWORK_CONFIGS } from '../src/config';
import { Network, Logger } from '../src/types/common';
import { MockProvider } from '../src/test/mocks/MockProvider';

const TEST_SECRET = 'SB6K2AINTGNYBFX4M7TRPGSKQ5RKNOXXWB7UZUHRYOVTM7REDUGECKZU';
const TEST_PUBLIC = Keypair.fromSecret(TEST_SECRET).publicKey();

const TESTNET_PASSPHRASE = NETWORK_CONFIGS[Network.TESTNET].networkPassphrase;
const FUTURENET_PASSPHRASE = NETWORK_CONFIGS[Network.STAGING].networkPassphrase;
const MAINNET_PASSPHRASE = NETWORK_CONFIGS[Network.MAINNET].networkPassphrase;

function createLoggerSpy(): jest.Mocked<Logger> {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

/**
 * Bind a map of URL -> MockProvider onto a CoralSwapClient so both the initial
 * server and any server created during pool rotation resolve offline.
 */
function bindMockProviders(
  client: CoralSwapClient,
  providers: Record<string, MockProvider>,
  initialUrl: string,
): jest.SpyInstance {
  client.server = providers[initialUrl] as unknown as rpc.Server;
  return jest
    .spyOn(client as unknown as { createRpcServer: (url: string) => rpc.Server }, 'createRpcServer')
    .mockImplementation((url: string) => {
      const provider = providers[url];
      if (!provider) {
        throw new Error(`No MockProvider registered for URL: ${url}`);
      }
      return provider as unknown as rpc.Server;
    });
}

describe('RPC endpoint network passphrase verification (#866)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('drops a futurenet URL from a [testnet, futurenet] pool under Network.TESTNET and routes all later calls to testnet', async () => {
    const testnetUrl = 'https://testnet.rpc.local';
    const futurenetUrl = 'https://futurenet.rpc.local';

    const testnetProvider = new MockProvider();
    testnetProvider.setLatestLedger(5001);
    testnetProvider.script('getNetwork', {
      passphrase: TESTNET_PASSPHRASE,
      protocolVersion: 22,
    });

    const futurenetProvider = new MockProvider();
    futurenetProvider.setLatestLedger(9999);
    futurenetProvider.script('getNetwork', {
      passphrase: FUTURENET_PASSPHRASE,
      protocolVersion: 22,
    });

    const testnetLedgerSpy = jest.spyOn(testnetProvider, 'getLatestLedger');
    const futurenetLedgerSpy = jest.spyOn(futurenetProvider, 'getLatestLedger');
    const logger = createLoggerSpy();

    const client = new CoralSwapClient({
      network: Network.TESTNET,
      secretKey: TEST_SECRET,
      rpcUrl: [testnetUrl, futurenetUrl],
      logger,
      maxRetries: 0,
      retryDelayMs: 0,
    });

    bindMockProviders(client, { [testnetUrl]: testnetProvider, [futurenetUrl]: futurenetProvider }, testnetUrl);

    // Call 1 hits testnetUrl; Call 2 rotates to futurenetUrl, detects mismatch,
    // drops futurenetUrl with a warning, and transparently falls back to testnetUrl;
    // Calls 3 & 4 continue exclusively on testnetUrl.
    const ledgers = [
      await client.getCurrentLedger(),
      await client.getCurrentLedger(),
      await client.getCurrentLedger(),
      await client.getCurrentLedger(),
    ];

    expect(ledgers).toEqual([5001, 5001, 5001, 5001]);
    expect(testnetLedgerSpy).toHaveBeenCalledTimes(4);
    expect(futurenetLedgerSpy).not.toHaveBeenCalled();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/passphrase mismatch/i),
      expect.objectContaining({
        url: futurenetUrl,
        expectedPassphrase: TESTNET_PASSPHRASE,
        actualPassphrase: FUTURENET_PASSPHRASE,
      }),
    );

    const verified = client.getVerifiedEndpoints();
    expect(verified.size).toBe(1);
    expect(verified.get(testnetUrl)).toEqual({
      passphrase: TESTNET_PASSPHRASE,
      protocolVersion: 22,
    });
    expect(verified.has(futurenetUrl)).toBe(false);
  });

  it('throws NetworkMismatchError on a single mismatched URL before any getAccount or simulateTransaction call', async () => {
    const mismatchedUrl = 'https://futurenet.rpc.local';
    const provider = new MockProvider();
    provider.setAccount(TEST_PUBLIC, { sequence: '100' });
    provider.script('getNetwork', {
      passphrase: FUTURENET_PASSPHRASE,
      protocolVersion: 21,
    });

    const getAccountSpy = jest.spyOn(provider, 'getAccount');
    const simulateSpy = jest.spyOn(provider, 'simulateTransaction');
    const sendSpy = jest.spyOn(provider, 'sendTransaction');

    const client = new CoralSwapClient({
      network: Network.TESTNET,
      secretKey: TEST_SECRET,
      rpcUrl: mismatchedUrl,
      maxRetries: 0,
      retryDelayMs: 0,
    });
    bindMockProviders(client, { [mismatchedUrl]: provider }, mismatchedUrl);

    const dummyOp = {} as xdr.Operation;

    // 1. getAccount() fails fast with NetworkMismatchError before provider.getAccount()
    await expect(client.getAccount()).rejects.toThrow(NetworkMismatchError);
    expect(getAccountSpy).not.toHaveBeenCalled();

    // Reset fresh client for simulateTransaction() check
    const clientSim = new CoralSwapClient({
      network: Network.TESTNET,
      secretKey: TEST_SECRET,
      rpcUrl: mismatchedUrl,
      maxRetries: 0,
      retryDelayMs: 0,
    });
    bindMockProviders(clientSim, { [mismatchedUrl]: provider }, mismatchedUrl);

    await expect(clientSim.simulateTransaction([dummyOp])).rejects.toThrow(NetworkMismatchError);
    expect(getAccountSpy).not.toHaveBeenCalled();
    expect(simulateSpy).not.toHaveBeenCalled();

    // Reset fresh client for submitTransaction() check (before signing or RPC dispatch)
    const clientSubmit = new CoralSwapClient({
      network: Network.TESTNET,
      secretKey: TEST_SECRET,
      rpcUrl: mismatchedUrl,
      maxRetries: 0,
      retryDelayMs: 0,
    });
    bindMockProviders(clientSubmit, { [mismatchedUrl]: provider }, mismatchedUrl);

    let caught: unknown;
    try {
      await clientSubmit.submitTransaction([dummyOp]);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(NetworkMismatchError);
    expect(caught).toBeInstanceOf(CoralSwapSDKError);
    const mismatch = caught as NetworkMismatchError;
    expect(mismatch.code).toBe('NETWORK_MISMATCH');
    expect(mismatch.expectedPassphrase).toBe(TESTNET_PASSPHRASE);
    expect(mismatch.actualPassphrase).toBe(FUTURENET_PASSPHRASE);
    expect(mismatch.rpcUrl).toBe(mismatchedUrl);

    expect(getAccountSpy).not.toHaveBeenCalled();
    expect(simulateSpy).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('verifies each URL only once and caches passphrase + protocolVersion across calls', async () => {
    const urlA = 'https://testnet-a.rpc.local';
    const urlB = 'https://testnet-b.rpc.local';

    let getNetworkCallsA = 0;
    let getNetworkCallsB = 0;

    const providerA = new MockProvider();
    providerA.setLatestLedger(1111);
    providerA.script('getNetwork', () => {
      getNetworkCallsA += 1;
      return { passphrase: TESTNET_PASSPHRASE, protocolVersion: 21 };
    });

    const providerB = new MockProvider();
    providerB.setLatestLedger(2222);
    providerB.script('getNetwork', () => {
      getNetworkCallsB += 1;
      return { passphrase: TESTNET_PASSPHRASE, protocolVersion: '22' };
    });

    const client = new CoralSwapClient({
      network: Network.TESTNET,
      secretKey: TEST_SECRET,
      rpcUrl: [urlA, urlB],
    });
    bindMockProviders(client, { [urlA]: providerA, [urlB]: providerB }, urlA);

    // 6 calls across 2 endpoints (3 calls per endpoint)
    for (let i = 0; i < 6; i++) {
      await client.getCurrentLedger();
    }

    expect(getNetworkCallsA).toBe(1);
    expect(getNetworkCallsB).toBe(1);
    expect(client.getVerifiedEndpoints().get(urlA)).toEqual({
      passphrase: TESTNET_PASSPHRASE,
      protocolVersion: 21,
    });
    expect(client.getVerifiedEndpoints().get(urlB)).toEqual({
      passphrase: TESTNET_PASSPHRASE,
      protocolVersion: 22,
    });
  });

  it('supports eager startup verification via client.verifyEndpoints()', async () => {
    const goodUrl = 'https://testnet-good.rpc.local';
    const badUrl = 'https://mainnet-wrong.rpc.local';

    const goodProvider = new MockProvider();
    goodProvider.script('getNetwork', { passphrase: TESTNET_PASSPHRASE, protocolVersion: 22 });

    const badProvider = new MockProvider();
    badProvider.script('getNetwork', { passphrase: MAINNET_PASSPHRASE, protocolVersion: 22 });

    const logger = createLoggerSpy();
    const client = new CoralSwapClient({
      network: Network.TESTNET,
      secretKey: TEST_SECRET,
      rpcUrl: [badUrl, goodUrl],
      logger,
    });
    bindMockProviders(client, { [badUrl]: badProvider, [goodUrl]: goodProvider }, badUrl);

    const verified = await client.verifyEndpoints();
    expect(verified.size).toBe(1);
    expect(verified.get(goodUrl)).toEqual({
      passphrase: TESTNET_PASSPHRASE,
      protocolVersion: 22,
    });
    expect(logger.warn).toHaveBeenCalledTimes(1);

    // Fails at startup if every endpoint in the pool is mismatched
    const allBadClient = new CoralSwapClient({
      network: Network.TESTNET,
      secretKey: TEST_SECRET,
      rpcUrl: badUrl,
    });
    bindMockProviders(allBadClient, { [badUrl]: badProvider }, badUrl);

    await expect(allBadClient.verifyEndpoints()).rejects.toThrow(NetworkMismatchError);
  });

  it('re-runs passphrase verification after setNetwork() and when addRpcEndpoint() adds a new URL', async () => {
    const sharedUrl = 'https://rpc.shared.local';
    const addedBadUrl = 'https://rpc.added-bad.local';
    const mainnetUrl = 'https://rpc.mainnet.local';

    const testnetProvider = new MockProvider();
    testnetProvider.setLatestLedger(700);
    testnetProvider.script('getNetwork', { passphrase: TESTNET_PASSPHRASE, protocolVersion: 21 });

    const futurenetProvider = new MockProvider();
    futurenetProvider.setLatestLedger(800);
    futurenetProvider.script('getNetwork', { passphrase: FUTURENET_PASSPHRASE, protocolVersion: 21 });

    const mainnetProvider = new MockProvider();
    mainnetProvider.setLatestLedger(900);
    mainnetProvider.script('getNetwork', { passphrase: MAINNET_PASSPHRASE, protocolVersion: 22 });

    const providers: Record<string, MockProvider> = {
      [sharedUrl]: testnetProvider,
      [addedBadUrl]: futurenetProvider,
      [mainnetUrl]: mainnetProvider,
    };

    const logger = createLoggerSpy();
    const client = new CoralSwapClient({
      network: Network.TESTNET,
      secretKey: TEST_SECRET,
      rpcUrl: sharedUrl,
      logger,
    });
    bindMockProviders(client, providers, sharedUrl);

    await expect(client.getCurrentLedger()).resolves.toBe(700);
    expect(client.getVerifiedEndpoints().has(sharedUrl)).toBe(true);

    // Dynamically adding a mismatched endpoint verifies & drops it immediately
    const addedInfo = await client.addRpcEndpoint(addedBadUrl);
    expect(addedInfo).toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(client.getVerifiedEndpoints().has(addedBadUrl)).toBe(false);
    await expect(client.getCurrentLedger()).resolves.toBe(700);

    // Switching to MAINNET while pointing at the TESTNET endpoint clears cache and rejects
    client.setNetwork(Network.MAINNET, sharedUrl);
    client.server = testnetProvider as unknown as rpc.Server;
    expect(client.getVerifiedEndpoints().size).toBe(0);

    await expect(client.getCurrentLedger()).rejects.toThrow(NetworkMismatchError);

    // Switching to MAINNET with a matching MAINNET endpoint succeeds and records metadata
    client.setNetwork(Network.MAINNET, mainnetUrl);
    client.server = mainnetProvider as unknown as rpc.Server;
    await expect(client.getCurrentLedger()).resolves.toBe(900);
    expect(client.getVerifiedEndpoints().get(mainnetUrl)).toEqual({
      passphrase: MAINNET_PASSPHRASE,
      protocolVersion: 22,
    });
  });
});
