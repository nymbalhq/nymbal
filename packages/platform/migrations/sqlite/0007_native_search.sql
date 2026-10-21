-- The native search index. Rows are keyed by `id` (an upsert is a point write); `rid` is an INTEGER PRIMARY KEY so
-- the external-content FTS5 index keys on a rowid that VACUUM cannot renumber. The *_terms columns hold the adapter's
-- normalised terms, space-joined, so unicode61 sees exactly those tokens. The triggers keep the index in step.
CREATE TABLE `search_documents` (
	`rid` integer PRIMARY KEY,
	`id` text NOT NULL UNIQUE,
	`type` text NOT NULL,
	`fields` text NOT NULL,
	`category_ids` text DEFAULT '[]' NOT NULL,
	`name_terms` text DEFAULT '' NOT NULL,
	`strong_terms` text DEFAULT '' NOT NULL,
	`body_terms` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE VIRTUAL TABLE `search_documents_fts` USING fts5(
	name_terms,
	strong_terms,
	body_terms,
	content='search_documents',
	content_rowid='rid',
	tokenize='unicode61'
);
--> statement-breakpoint
CREATE TRIGGER `search_documents_ai` AFTER INSERT ON `search_documents` BEGIN
	INSERT INTO search_documents_fts (rowid, name_terms, strong_terms, body_terms)
	VALUES (new.rid, new.name_terms, new.strong_terms, new.body_terms);
END;
--> statement-breakpoint
CREATE TRIGGER `search_documents_ad` AFTER DELETE ON `search_documents` BEGIN
	INSERT INTO search_documents_fts (search_documents_fts, rowid, name_terms, strong_terms, body_terms)
	VALUES ('delete', old.rid, old.name_terms, old.strong_terms, old.body_terms);
END;
--> statement-breakpoint
CREATE TRIGGER `search_documents_au` AFTER UPDATE ON `search_documents` BEGIN
	INSERT INTO search_documents_fts (search_documents_fts, rowid, name_terms, strong_terms, body_terms)
	VALUES ('delete', old.rid, old.name_terms, old.strong_terms, old.body_terms);
	INSERT INTO search_documents_fts (rowid, name_terms, strong_terms, body_terms)
	VALUES (new.rid, new.name_terms, new.strong_terms, new.body_terms);
END;
