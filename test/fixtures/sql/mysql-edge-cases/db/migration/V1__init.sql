/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
SET NAMES utf8mb4;

CREATE TABLE `users` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `email` varchar(191) COLLATE utf8mb4_unicode_ci NOT NULL,
  `name` varchar(255) CHARACTER SET utf8mb4 NOT NULL DEFAULT '',
  `status` enum('active','banned') NOT NULL DEFAULT 'active',
  `roles` set('admin','editor') DEFAULT NULL,
  `score` decimal(8,2) unsigned DEFAULT '0.00',
  `ratio` double DEFAULT NULL,
  `is_admin` tinyint(1) NOT NULL DEFAULT '0',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `bio` text COMMENT 'About; me',
  `uuid` char(36) NOT NULL DEFAULT (uuid()),
  `full_name` varchar(300) GENERATED ALWAYS AS (concat(`name`,' ',`email`)) VIRTUAL,
  `key` varchar(32) DEFAULT NULL,
  /*!50705 `location` point */ /*!80003 SRID 0 */ /*!50705 DEFAULT NULL,*/
  PRIMARY KEY (`id`),
  UNIQUE KEY `users_email_unique` (`email`),
  KEY `users_name_index` (`name`(20)),
  KEY `users_status_created_index` (`status`, `created_at` DESC),
  FULLTEXT KEY `users_bio_fulltext` (`bio`)
) ENGINE=InnoDB AUTO_INCREMENT=3 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='The users';

CREATE TABLE posts (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  title VARCHAR(200) NOT NULL,
  slug VARCHAR(200),
  INDEX posts_title_idx USING BTREE (title),
  UNIQUE INDEX (slug),
  CONSTRAINT posts_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE ON UPDATE RESTRICT
) ENGINE=InnoDB;
