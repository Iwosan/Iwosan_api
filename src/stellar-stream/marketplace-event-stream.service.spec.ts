jest.unmock('@stellar/stellar-sdk');

import { ConfigService } from '@nestjs/config';
import * as StellarSdk from '@stellar/stellar-sdk';
import { MarketplaceContractReader } from '../marketplace/marketplace-contract.reader';
import { MarketplaceOrdersService } from '../marketplace/marketplace-orders.service';
import { MarketplaceEventStreamService } from './marketplace-event-stream.service';

const ORDER = {
  onChainOrderId: '7',
  onChainListingId: '3',
  buyerAddress: 'GBUYER',
  sellerAddress: 'GSELLER',
  units: 2,
  amount: '300',
};

function event(topics: StellarSdk.xdr.ScVal[], value: StellarSdk.xdr.ScVal, id = 'evt-1') {
  return {
    id,
    type: 'contract',
    ledger: 42,
    ledgerClosedAt: '2026-01-01T00:00:00Z',
    contractId: 'CCONTRACT',
    txHash: 'tx-1',
    topic: topics,
    value,
  } as unknown as StellarSdk.SorobanRpc.Api.EventResponse;
}

const symbol = (value: string) => StellarSdk.nativeToScVal(value, { type: 'symbol' });
const u64 = (value: number) => StellarSdk.nativeToScVal(BigInt(value), { type: 'u64' });

describe('MarketplaceEventStreamService', () => {
  let service: MarketplaceEventStreamService;
  let orders: { recordOrder: jest.Mock; settleOrder: jest.Mock; markListingVerified: jest.Mock };
  let reader: { getOrder: jest.Mock };

  beforeEach(() => {
    orders = {
      recordOrder: jest.fn().mockResolvedValue(ORDER),
      settleOrder: jest.fn().mockResolvedValue(null),
      markListingVerified: jest.fn().mockResolvedValue(undefined),
    };
    reader = { getOrder: jest.fn().mockResolvedValue(ORDER) };

    const config = {
      get: (key: string, defaultValue?: string) => {
        const values: Record<string, string> = {
          STELLAR_MARKETPLACE_EVENTS_ENABLED: 'false',
        };
        return values[key] ?? defaultValue;
      },
    } as unknown as ConfigService;

    service = new MarketplaceEventStreamService(
      config,
      orders as unknown as MarketplaceOrdersService,
      reader as unknown as MarketplaceContractReader,
    );
  });

  it('indexes an ordered event using the order read from the contract', async () => {
    await service.handleEvent(event([symbol('ordered'), u64(7)], StellarSdk.nativeToScVal(300)));

    expect(reader.getOrder).toHaveBeenCalledWith('7');
    expect(orders.recordOrder).toHaveBeenCalledWith({
      ...ORDER,
      txHash: 'tx-1',
      ledger: 42,
    });
  });

  it('does not fail when the ordered order cannot be read', async () => {
    reader.getOrder.mockResolvedValueOnce(null);

    await service.handleEvent(event([symbol('ordered'), u64(7)], StellarSdk.nativeToScVal(300)));

    expect(orders.recordOrder).not.toHaveBeenCalled();
  });

  it('releases escrow on a settled event', async () => {
    await service.handleEvent(event([symbol('settled'), u64(7)], StellarSdk.nativeToScVal(true)));

    expect(orders.settleOrder).toHaveBeenCalledWith('7', true);
  });

  it('refunds escrow on a settled event with false', async () => {
    await service.handleEvent(event([symbol('settled'), u64(7)], StellarSdk.nativeToScVal(false)));

    expect(orders.settleOrder).toHaveBeenCalledWith('7', false);
  });

  it('marks a listing verified on a verified event', async () => {
    await service.handleEvent(event([symbol('verified'), u64(3)], StellarSdk.nativeToScVal(null)));

    expect(orders.markListingVerified).toHaveBeenCalledWith('3');
  });

  it('ignores listed events', async () => {
    await service.handleEvent(
      event([symbol('listed'), u64(3)], StellarSdk.nativeToScVal('GSELLER')),
    );

    expect(reader.getOrder).not.toHaveBeenCalled();
    expect(orders.recordOrder).not.toHaveBeenCalled();
    expect(orders.settleOrder).not.toHaveBeenCalled();
  });

  it('ignores unrelated events', async () => {
    await service.handleEvent(event([symbol('transfer'), u64(3)], StellarSdk.nativeToScVal(1)));

    expect(orders.recordOrder).not.toHaveBeenCalled();
    expect(orders.settleOrder).not.toHaveBeenCalled();
    expect(orders.markListingVerified).not.toHaveBeenCalled();
  });
});
