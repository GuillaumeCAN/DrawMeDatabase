-- In a sub-folder: Flyway reads them too, by version
CREATE TABLE settings (`key` VARCHAR(64) NOT NULL PRIMARY KEY, `value` JSON);
