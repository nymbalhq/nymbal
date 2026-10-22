-- What a read-model rebuild's catch-up reads: the events not dead, delivered at or after a time or not yet, by seq.
CREATE INDEX `events_catch_up_idx` ON `events` (`dead_at`,`delivered_at`,`seq`);
