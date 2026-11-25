import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DrugBatchContractReader, OnChainDrugBatch } from './drug-batch-contract.reader';
import { DrugBatchesService } from './drug-batches.service';

const BATCH_ID = 'ab'.repeat(32);
const NOW_SECONDS = Math.floor(Date.now() / 1000);

function batch(overrides: Partial<OnChainDrugBatch> = {}): OnChainDrugBatch {
  return {
    batchId: BATCH_ID,
    manufacturer: 'GMANUFACTURER',
    product: 'Amoxicillin 500mg',
    kind: 'orthodox_drug',
    expiry: NOW_SECONDS + 86_400,
    regulatoryNumber: 'A4-1234',
    holder: 'GPHARMACY',
    recalled: false,
    ...overrides,
  };
}

describe('DrugBatchesService', () => {
  let reader: { getBatch: jest.Mock; getHistory: jest.Mock };
  let service: DrugBatchesService;

  beforeEach(() => {
    reader = {
      getBatch: jest.fn().mockResolvedValue(batch()),
      getHistory: jest.fn().mockResolvedValue([
        { from: null, to: 'GMANUFACTURER', at: NOW_SECONDS - 100 },
        { from: 'GMANUFACTURER', to: 'GPHARMACY', at: NOW_SECONDS - 50 },
      ]),
    };
    const config = {
      get: jest.fn((key: string, fallback?: string) =>
        key === 'WEB_APP_URL' ? 'https://iwosan.example/' : fallback,
      ),
    } as unknown as ConfigService;
    service = new DrugBatchesService(reader as unknown as DrugBatchContractReader, config);
  });

  it('returns a valid batch with its custody chain', async () => {
    const result = await service.verify(BATCH_ID);

    expect(result.status).toBe('valid');
    expect(result.recalled).toBe(false);
    expect(result.expired).toBe(false);
    expect(result.history).toHaveLength(2);
    expect(result.history[0].from).toBeNull();
    expect(result.verifyUrl).toBe(`https://iwosan.example/verify/${BATCH_ID}`);
  });

  it('throws 404 for an unknown batch', async () => {
    reader.getBatch.mockResolvedValue(null);

    await expect(service.verify(BATCH_ID)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('flags a recalled batch, even when it is also expired', async () => {
    reader.getBatch.mockResolvedValue(batch({ recalled: true, expiry: NOW_SECONDS - 10 }));

    const result = await service.verify(BATCH_ID);

    expect(result.status).toBe('recalled');
    expect(result.recalled).toBe(true);
    expect(result.expired).toBe(true);
  });

  it('flags an expired batch', async () => {
    reader.getBatch.mockResolvedValue(batch({ expiry: NOW_SECONDS - 10 }));

    expect((await service.verify(BATCH_ID)).status).toBe('expired');
  });

  it('caches reads and treats ids case-insensitively', async () => {
    await service.verify(BATCH_ID);
    await service.verify(BATCH_ID.toUpperCase());

    expect(reader.getBatch).toHaveBeenCalledTimes(1);
  });

  it('reads again after forget()', async () => {
    await service.verify(BATCH_ID);
    service.forget(BATCH_ID);
    await service.verify(BATCH_ID);

    expect(reader.getBatch).toHaveBeenCalledTimes(2);
  });

  it('renders a PNG QR code', async () => {
    const png = await service.qrCode(BATCH_ID);

    // PNG files start with the bytes 0x89 'P' 'N' 'G'.
    expect(png.subarray(0, 4).toString('hex')).toBe('89504e47');
  });
});
