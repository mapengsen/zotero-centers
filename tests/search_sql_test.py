"""Exercise the actual projection SQL against an in-memory Zotero-shaped schema."""
import json
from pathlib import Path
import sqlite3
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]
SQL = json.loads(subprocess.check_output([
    'node', '-e', 'const e=require("./addon/modules/global-search/engine.js");console.log(JSON.stringify([e.SQL_ITEMS,e.SQL_FIELDS]))'
], cwd=ROOT, text=True))


class ProjectionTest(unittest.TestCase):
    def test_all_sources(self):
        db = sqlite3.connect(':memory:')
        db.executescript('''
          CREATE TABLE items (itemID, libraryID, key, dateAdded, dateModified, itemTypeID);
          CREATE TABLE itemAttachments (itemID, parentItemID, path, contentType);
          CREATE TABLE itemNotes (itemID, parentItemID, note);
          CREATE TABLE itemAnnotations (itemID, parentItemID, text, comment, authorName, pageLabel);
          CREATE TABLE deletedItems (itemID);
          CREATE TABLE itemData (itemID, fieldID, valueID);
          CREATE TABLE fieldsCombined (fieldID, fieldName);
          CREATE TABLE itemDataValues (valueID, value);
          CREATE TABLE itemCreators (itemID, creatorID);
          CREATE TABLE creators (creatorID, firstName, lastName);
          CREATE TABLE itemTags (itemID, tagID);
          CREATE TABLE tags (tagID, name);
          CREATE TABLE itemTypesCombined (itemTypeID, typeName);
          CREATE TABLE collectionItems (itemID, collectionID);
          CREATE TABLE collections (collectionID, collectionName);
          CREATE TABLE itemRelations (itemID, object);
          INSERT INTO items VALUES (1,1,'ROOTKEY1','2026-11-08','2026-11-08',1),
            (2,1,'PDFKEY02','2026-11-08','2026-11-08',2),
            (3,1,'NOTEKEY3','2026-11-08','2026-11-08',3),
            (4,1,'ANNOT004','2026-11-08','2026-11-08',4);
          INSERT INTO itemAttachments VALUES (2,1,'storage:test.pdf','application/pdf');
          INSERT INTO itemNotes VALUES (3,1,'<p>visible note</p>');
          INSERT INTO itemAnnotations VALUES (4,2,'基因','comment','reader','7');
          INSERT INTO fieldsCombined VALUES (1,'title'),(2,'extra'),(3,'DOI');
          INSERT INTO itemDataValues VALUES (1,'A title'),(2,'Custom: field'),(3,'10.1/test');
          INSERT INTO itemData VALUES (1,1,1),(1,2,2),(1,3,3);
          INSERT INTO creators VALUES (1,'Ada','Lovelace');
          INSERT INTO itemCreators VALUES (1,1);
          INSERT INTO tags VALUES (1,'tag');
          INSERT INTO itemTags VALUES (1,1);
          INSERT INTO itemTypesCombined VALUES (1,'journalArticle'),(2,'attachment'),(3,'note'),(4,'annotation');
          INSERT INTO collections VALUES (1,'DNA');
          INSERT INTO collectionItems VALUES (1,1);
          INSERT INTO itemRelations VALUES (1,'http://zotero.org/relation');
        ''')
        ancestry = list(db.execute(SQL[0]))
        self.assertEqual(ancestry[-1], (4, 1, 2, 0))
        fields = list(db.execute(SQL[1]))
        expected = {'title', 'extra', 'DOI', 'creator', 'tag', 'note', 'annotationText',
                    'annotationComment', 'annotationAuthor', 'annotationPage',
                    'attachmentPath', 'contentType', 'key', 'dateAdded', 'dateModified',
                    'itemType', 'collection', 'related'}
        self.assertEqual({row[1] for row in fields}, expected)
        self.assertIn((1, 'creator', 'Ada Lovelace'), fields)
        self.assertIn((1, 'creator', 'Lovelace Ada'), fields)
        db.execute('INSERT INTO deletedItems VALUES (2)')
        self.assertEqual(list(db.execute(SQL[0]))[1][-1], 1)


if __name__ == '__main__':
    unittest.main()
