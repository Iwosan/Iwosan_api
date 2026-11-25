import { Repository } from 'typeorm';
import { User } from '../auth/entities/user.entity';
import { MarketplaceOrder } from '../marketplace/entities/marketplace-order.entity';
import { MarketplaceOrdersService } from '../marketplace/marketplace-orders.service';
import {
  NotificationOutboxEntry,
  OutboxStatus,
} from '../notifications/entities/notification-outbox.entity';
import { NotificationEventType } from '../notifications/interfaces/notification-event.interface';
import { NotificationOutboxService } from '../notifications/services/notification-outbox.service';
import { RecallNotificationsService } from './recall-notifications.service';

const BATCH = 'cd'.repeat(32);

function order(buyerAddress: string, title = 'Paracetamol 500mg'): MarketplaceOrder {
  return { buyerAddress, listing: { title } } as unknown as MarketplaceOrder;
}

describe('RecallNotificationsService', () => {
  let orders: { findByBatch: jest.Mock };
  let outbox: { enqueue: jest.Mock };
  let users: { createQueryBuilder: jest.Mock };
  let outboxEntries: { find: jest.Mock };
  let service: RecallNotificationsService;

  const linkedUsers = (list: Array<{ id: string; stellarPublicKey: string }>) => {
    users.createQueryBuilder.mockReturnValue({
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue(list),
    });
  };

  beforeEach(() => {
    orders = { findByBatch: jest.fn().mockResolvedValue([]) };
    outbox = { enqueue: jest.fn().mockResolvedValue(undefined) };
    users = { createQueryBuilder: jest.fn() };
    outboxEntries = { find: jest.fn().mockResolvedValue([]) };
    linkedUsers([]);
    service = new RecallNotificationsService(
      orders as unknown as MarketplaceOrdersService,
      outbox as unknown as NotificationOutboxService,
      users as unknown as Repository<User>,
      outboxEntries as unknown as Repository<NotificationOutboxEntry>,
    );
  });

  it('notifies each buyer once, even with several orders from the same batch', async () => {
    orders.findByBatch.mockResolvedValue([order('GALICE'), order('GALICE'), order('GBOB')]);
    linkedUsers([
      { id: 'alice', stellarPublicKey: 'GALICE' },
      { id: 'bob', stellarPublicKey: 'GBOB' },
    ]);

    const result = await service.handleRecall(BATCH, 'tx-hash');

    expect(result).toMatchObject({ affectedOrders: 3, affectedBuyers: 2, queued: 2 });
    expect(outbox.enqueue).toHaveBeenCalledTimes(2);
    const recallMetadata: unknown = expect.objectContaining({
      product: 'Paracetamol 500mg',
      txHash: 'tx-hash',
    });
    expect(outbox.enqueue).toHaveBeenCalledWith(
      `drug-recall:${BATCH}:alice`,
      expect.objectContaining({
        eventType: NotificationEventType.DRUG_RECALL,
        resourceId: BATCH,
        metadata: recallMetadata,
      }),
      'alice',
    );
  });

  it('uses the same dedupe key when the recall is processed again', async () => {
    orders.findByBatch.mockResolvedValue([order('GALICE')]);
    linkedUsers([{ id: 'alice', stellarPublicKey: 'GALICE' }]);

    await service.handleRecall(BATCH);
    await service.handleRecall(BATCH.toUpperCase());

    const keys = outbox.enqueue.mock.calls.map((call: unknown[]) => call[0]);
    expect(keys).toEqual([`drug-recall:${BATCH}:alice`, `drug-recall:${BATCH}:alice`]);
  });

  it('reports buyers without a linked account as unreachable', async () => {
    orders.findByBatch.mockResolvedValue([order('GALICE'), order('GNOACCOUNT')]);
    linkedUsers([{ id: 'alice', stellarPublicKey: 'GALICE' }]);

    const result = await service.handleRecall(BATCH);

    expect(result.queued).toBe(1);
    expect(result.unreachableBuyers).toEqual(['GNOACCOUNT']);
  });

  it('does nothing when no order used the batch', async () => {
    const result = await service.handleRecall(BATCH);

    expect(result.affectedOrders).toBe(0);
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it('summarises reach from the outbox', async () => {
    orders.findByBatch.mockResolvedValue([order('GALICE'), order('GBOB'), order('GCAROL')]);
    linkedUsers([
      { id: 'alice', stellarPublicKey: 'GALICE' },
      { id: 'bob', stellarPublicKey: 'GBOB' },
    ]);
    outboxEntries.find.mockResolvedValue([
      { status: OutboxStatus.COMPLETED },
      { status: OutboxStatus.FAILED },
    ]);

    const reach = await service.reach(BATCH);

    expect(reach).toEqual({
      batchId: BATCH,
      affectedOrders: 3,
      affectedBuyers: 3,
      notified: 1,
      pending: 0,
      failed: 1,
      unreachable: 1,
    });
  });
});
