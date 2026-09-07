-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Mensagem" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "autor" TEXT NOT NULL,
    "texto" TEXT NOT NULL,
    "sala" TEXT NOT NULL DEFAULT 'geral',
    "criadoEm" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_Mensagem" ("autor", "criadoEm", "id", "texto") SELECT "autor", "criadoEm", "id", "texto" FROM "Mensagem";
DROP TABLE "Mensagem";
ALTER TABLE "new_Mensagem" RENAME TO "Mensagem";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
