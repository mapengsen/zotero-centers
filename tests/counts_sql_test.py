import json
from pathlib import Path
import sqlite3
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]
SQL, LIBRARY_SQL = json.loads(subprocess.check_output(['node', '-e',
    'const c=require("./addon/metrics-core.js");console.log(JSON.stringify([c.COUNT_SQL,c.LIBRARY_COUNT_SQL]))'], cwd=ROOT, text=True))

class CountsTest(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.addCleanup(self.db.close)
        self.db.executescript('''
          CREATE TABLE libraries(libraryID,type);
          INSERT INTO libraries VALUES(1,'user'),(2,'group'),(3,'feed'),(4,'group');
          CREATE TABLE collections(collectionID,parentCollectionID,libraryID);
          CREATE TABLE deletedCollections(collectionID);
          CREATE TABLE collectionItems(collectionID,itemID);
          CREATE TABLE items(itemID,itemTypeID,libraryID);
          CREATE TABLE itemTypesCombined(itemTypeID,typeName);
          CREATE TABLE deletedItems(itemID);
          CREATE TABLE feedItems(itemID);
          INSERT INTO itemTypesCombined VALUES(1,'journalArticle'),(2,'attachment'),(3,'note'),(4,'annotation');
          INSERT INTO collections VALUES(1,NULL,1),(2,1,1),(3,NULL,1),(4,NULL,1),
            (5,2,1),(6,1,1),(7,NULL,1),(8,7,1),(9,NULL,2),(10,9,2),(11,1,1),(12,11,1);
          INSERT INTO items VALUES(1,1,1),(2,1,1),(3,2,1),(4,3,1),(5,4,1),(6,1,1),
            (7,1,1),(8,1,1),(9,1,1),(11,1,1),(12,1,2),(13,1,1),(14,1,1),(15,1,1),(16,1,3);
          INSERT INTO collectionItems VALUES(1,1),(1,2),(1,3),(1,4),(1,5),(1,6),(1,7),
            (2,2),(2,8),(3,1),(5,9),(6,1),(6,9),(8,11),(10,12),(11,13),(12,14);
          INSERT INTO deletedItems VALUES(6);
          INSERT INTO feedItems VALUES(7);
          INSERT INTO deletedCollections VALUES(11);
        ''')

    def counts(self):
        return dict(self.db.execute(SQL))

    def test_all_descendant_documents_deduplicated_excluding_folders_and_nonreferences(self):
        self.assertEqual(self.counts(), {1: 4, 2: 3, 3: 1, 4: 0, 5: 1, 6: 2,
                                        7: 1, 8: 1, 9: 1, 10: 1, 12: 1})
        self.db.execute('INSERT INTO collections VALUES(15,5,1)')
        self.assertEqual(self.counts()[1], 4)
        self.assertEqual(self.counts()[15], 0)

    def test_trash_and_restore_update_all_ancestors_and_exclude_deleted_subtrees(self):
        self.db.execute('INSERT INTO deletedItems VALUES(9)')
        counts = self.counts()
        self.assertEqual([counts[i] for i in (1, 2, 5, 6)], [3, 2, 0, 1])
        self.db.execute('DELETE FROM deletedItems WHERE itemID=9')
        self.assertEqual(self.counts()[1], 4)
        self.db.execute('INSERT INTO deletedCollections VALUES(2)')
        self.assertEqual(self.counts()[1], 3)
        self.db.execute('DELETE FROM deletedCollections WHERE collectionID=2')
        self.assertEqual(self.counts()[1], 4)
        self.assertEqual(self.counts()[9], 1)

    def test_document_and_subtree_moves_recompute_both_ancestors(self):
        self.db.execute('DELETE FROM collectionItems WHERE collectionID=2 AND itemID=8')
        self.db.execute('INSERT INTO collectionItems VALUES(3,8)')
        self.assertEqual([self.counts()[i] for i in (1, 2, 3)], [3, 2, 2])
        self.db.execute('UPDATE collections SET parentCollectionID=3 WHERE collectionID=5')
        self.assertEqual([self.counts()[i] for i in (1, 2, 3)], [3, 1, 3])
        self.db.execute('UPDATE collections SET parentCollectionID=3 WHERE collectionID=6')
        self.assertEqual([self.counts()[i] for i in (1, 2, 3)], [2, 1, 3])

    def test_library_total_includes_unfiled_once_and_refreshes_on_trash_and_restore(self):
        self.assertEqual(dict(self.db.execute(LIBRARY_SQL)), {1: 8, 2: 1, 4: 0})
        self.db.executemany('INSERT INTO collectionItems VALUES(?,15)', [(1,), (2,), (5,)])
        self.assertEqual(dict(self.db.execute(LIBRARY_SQL)), {1: 8, 2: 1, 4: 0})
        self.db.execute('INSERT INTO deletedItems VALUES(15)')
        self.assertEqual(dict(self.db.execute(LIBRARY_SQL)), {1: 7, 2: 1, 4: 0})
        self.db.execute('DELETE FROM deletedItems WHERE itemID=15')
        self.assertEqual(dict(self.db.execute(LIBRARY_SQL)), {1: 8, 2: 1, 4: 0})

if __name__ == '__main__':
    unittest.main()
