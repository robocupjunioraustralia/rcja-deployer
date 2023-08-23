# RCJ CMS Deployer

This is a tool used for managing deployments of the RCJ CMS (https://github.com/robocupjunior/rcj_cms)

## Installation

- This tool requires NodeJS, if you haven't already installed it, you can find the latest version [here](https://nodejs.org/en/download)
1. Clone the repository: `git clone https://github.com/robocupjunioraustralia/rcja-deployer.git`
2. Install dependencies: `npm install`

## Configuration

### .env

- The `.env` file contains sensitive information and should not be committed to the repository.
- Copy the contents of `.env.example` to a new `.env`, then populate it with your own settings. 

The following variables must be set for the deployment scripts to work.
| Variable | Description |
| --- | --- |
| DB_HOST<br>DB_USER<br>DB_PASSWORD | Details for the MariaDB server with a working instance of the RCJCMS |
| DB_CACHE_NAME | Required for the anonymise function.<br>The name of the MySQL database to use for caching names |
| | |
| PHP_PATH<br>MYSQL_PATH<br>MYSQLDUMP_PATH<br>COMPOSER_PATH | The paths to your php, mysql, mysqldump, and composer executables.<br>There are some suggestions in the sample file for windows/linux |

Some other variables of note include the following, these are only required if you want to run the full server (`npm start`)
| Variable | Description |
| --- | --- |
| DEPLOY_SECRET | Secret used for authenticating requests from GitHub |
| SMTP_* | Email configuration details for deployment alerts |
| SYNC_FROM_DEPLOYMENT<br>SYNC_TO_DEPLOYMENT | The deployment to sync from and to.<br>This is used by the full server to sync the staging server with production each night |
| ANON_PASSWORD | The (unhashed) password that will be set for every user after anonymisation. This may be useful for testing. It isn't required. |

### deployments.json

- The `deployments.json` file contains information about each deployment on your system.\
During development, this would normally only have one entry.

The sample included is meant for a full deployment, for a development instance on Windows using XAMPP, something like the following could be used:
```json
{
    "develop" : {
        "title": "RCJCMS - Development",
        "path": "C:/xampp/htdocs/rcj_cms/",
        "migration_folder": "updates",
        "database_prefix": "rcj_cms",
        "repository": "robocupjunioraustralia/rcj_cms",
        "pull_cmd": "git fetch --all && git pull git status",
        "backup": true,
        "branch_ref": "refs/heads/develop"
    }
}
```

Here's a quick explanation of each variable:
| Variable | Description |
| --- | --- |
| *title | The name of the deployment |
| *path | The local path to the deployment files |
| *migration_folder | The folder containing database migration scripts |
| *database_prefix | The prefix of the MySQL databases used by the deployment |
| *repository | The GitHub repository containing the deployment files |
| *pull_cmd | The command to use to pull latest changes from the repository |
| backup | Whether or not to backup the database before running migrations |
| branch_ref | The git ref for confirming the branch sent from the the webhook |


## Usage

### Start the server
```
npm start
```

- This starts the full server and listens for incoming deployment requests. Make sure all configuration is setup \
This also creates a cronjob for each night at 12PM to sync a prod database to staging

### Other Commands (Useful for development)

- You can use these commands to assist you while developing.\
For instance, if you have recieved new changes from develop, it is a good idea to run the `npm run migrate` command to make sure your database is up to date.

- Append a deployment key to the end of any of these (`npm run migrate [deployment]`) to change the deployment the command will use. Otherwise, it will just choose the first one alphabetically.

#### Migrate Database

Runs any new migration scripts in the updates folder.
```
npm run migrate
```

#### Rebuild Views

Rebuilds all views in the database.
```
npm run rebuildViews 
```

#### Rebuild Users

Rebuilds all users in the database.
```
npm run rebuildViews 
```

#### Anonymise Database

Anonymises the database.
```
npm run anonymise
```

#### Run database sync

Syncronises the production database to the development database
- uses `env.SYNC_FROM_DEPLOYMENT` and `env.SYNC_TO_DEPLOYMENT` to determine which deployments to sync
```
npm run syncDatabases
```
