-- What a read-model rebuild's catch-up reads: the events not dead, delivered at or after a time or not yet, by seq.
CREATE INDEX IF NOT EXISTS "events_catch_up_idx" ON "events" USING btree ("dead_at","delivered_at","seq");
