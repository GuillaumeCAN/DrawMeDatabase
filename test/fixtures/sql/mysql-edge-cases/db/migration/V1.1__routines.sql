DELIMITER ;;
CREATE TRIGGER posts_before_insert BEFORE INSERT ON posts FOR EACH ROW
BEGIN
  IF NEW.slug IS NULL THEN
    SET NEW.slug = LOWER(NEW.title);
  END IF;
END ;;
CREATE PROCEDURE add_column_later()
BEGIN
  ALTER TABLE posts ADD COLUMN never_added INT;
END ;;
DELIMITER ;
# A comment of MySQL; CREATE TABLE ghost (id int);
CREATE TABLE tags (id INT AUTO_INCREMENT, name VARCHAR(50) NOT NULL, KEY (name), PRIMARY KEY (id));
