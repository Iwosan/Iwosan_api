import { ConfigService } from '@nestjs/config';
import * as StellarSdk from '@stellar/stellar-sdk';
import { DrugBatchEventStreamService } from './drug-batch-event-stream.service';
import { DrugBatchesService } from './drug-batches.service';
import { RecallNotificationsService } from './recall-notifications.service';

// The shared manual mock has no ScVal encoding; these tests decode real events.
jest.unmock('@stellar/stellar-sdk');

const BATCH = 'ef'.repeat(32);

function event(topic: string, batchId?: string): StellarSdk.SorobanRpc.Api.EventResponse {
  const topics = [StellarSdk.nativeToScVal(topic, { type: 'symbol' })];
  if (batchId) {
    topics.push(StellarSdk.xdr.ScVal.scvBytes(Buffer.from(batchId, 'hex')));
  }
  return {
    id: 'event-1',
    txHash: 'tx-hash',
    topic: topics,
  } as unknown as StellarSdk.SorobanRpc.Api.EventResponse;
}

describe('DrugBatchEventStreamService', () => {
  let batches: { forget: jest.Mock };
  let recalls: { handleRecall: jest.Mock };
  let stream: DrugBatchEventStreamService;

  beforeEach(() => {
    batches = { forget: jest.fn() };
    recalls = { handleRecall: jest.fn().mockResolvedValue(undefined) };
    // Disabled: no RPC client or Redis connection is created.
    const config = {
      get: jest.fn((_key: string, fallback?: string) => fallback),
    } as unknown as ConfigService;
    stream = new DrugBatchEventStreamService(
      config,
      batches as unknown as DrugBatchesService,
      recalls as unknown as RecallNotificationsService,
    );
  });

  it('notifies buyers and clears the cache for a recalled event', async () => {
    await stream.handleEvent(event('recalled', BATCH));

    expect(batches.forget).toHaveBeenCalledWith(BATCH);
    expect(recalls.handleRecall).toHaveBeenCalledWith(BATCH, 'tx-hash');
  });

  it('ignores other registry events', async () => {
    await stream.handleEvent(event('custody', BATCH));
    await stream.handleEvent(event('registered', BATCH));

    expect(recalls.handleRecall).not.toHaveBeenCalled();
  });

  it('skips a recalled event without a batch id', async () => {
    await stream.handleEvent(event('recalled'));

    expect(recalls.handleRecall).not.toHaveBeenCalled();
  });

  it('does not poll while disabled', async () => {
    await expect(stream.pollOnce()).resolves.toBe(0);
  });
});
