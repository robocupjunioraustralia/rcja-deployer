-- rcj_cms_deployer_cache
DROP TABLE IF EXISTS `imported_team_member`;
DROP TABLE IF EXISTS `imported_mentor`;
DROP TABLE IF EXISTS `user`;

CREATE TABLE `imported_team_member` (
    `id` int(11) NOT NULL AUTO_INCREMENT,
    `uid_comp` varchar(13) NOT NULL,
    `uid_imported_team_member` varchar(13) NOT NULL,
    `first_name` varchar(60) NOT NULL,
    `last_name` varchar(60) NOT NULL,
    `old_first_name` varchar(60) NOT NULL,
    `old_last_name` varchar(60) NOT NULL,
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `imported_mentor` (
    `id` int(11) NOT NULL AUTO_INCREMENT,
    `uid_comp` varchar(13) NOT NULL,
    `uid_imported_mentor` varchar(13) NOT NULL,
    `mentor_first` varchar(100) NOT NULL,
    `mentor_last` varchar(100) NOT NULL,
    `mentor_email` varchar(100) NOT NULL,
    `mentor_phone` varchar(50) NULL,
    `old_mentor_first` varchar(100) NOT NULL,
    `old_mentor_last` varchar(100) NOT NULL,
    `old_mentor_email` varchar(100) NOT NULL,
    `old_mentor_phone` varchar(50) NULL,
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `user` (
    `id` int(11) NOT NULL AUTO_INCREMENT,
    `uid_user` varchar(13) NOT NULL,
    `uid_comp` varchar(13) NOT NULL,
    `first_name` varchar(60) NOT NULL,
    `last_name` varchar(60) NOT NULL,
    `username` varchar(50) NOT NULL,
    `phone_number` varchar(50) NOT NULL,
    `old_first_name` varchar(60) NOT NULL,
    `old_last_name` varchar(60) NOT NULL,
    `old_username` varchar(50) NOT NULL,
    `old_phone_number` varchar(50) NOT NULL,
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;