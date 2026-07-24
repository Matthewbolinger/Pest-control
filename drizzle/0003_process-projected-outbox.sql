-- Existing workflow and evidence events were already projected atomically in
-- the same transaction. Only proof delivery has an external side effect and
-- therefore remains pending for the delivery worker.
UPDATE outbox_events
SET status = 'PROCESSED',
    attempts = CASE WHEN attempts < 1 THEN 1 ELSE attempts END,
    processed_at = COALESCE(processed_at, updated_at),
    last_error = NULL,
    version = version + 1
WHERE event_type <> 'SERVICE_PROOF_DELIVERY_QUEUED'
  AND status IN ('PENDING', 'PROCESSING');
