// Runner for command-line scripts

const { exec } = require('child_process');
const express = require("express");
const bodyParser = require("body-parser");
const morgan = require("morgan");
const dotenv = require("dotenv");
const path = require("path");
const crypto = require('crypto');
const fs = require('fs');
const nodemailer = require('nodemailer');

const { rebuildViews } = require('./functions/rebuildViews');
const { syncDatabases } = require('./functions/syncDatabases');
const { anonymiseDatabase } = require('./functions/anonymiseDatabase');
const { createDatabaseBackup } = require('./functions/backup');
const { runDatabaseMigrations } = require('./functions/migrate');
const { enableMaintenance, disableMaintenance } = require('./functions/maintenance');

dotenv.config();

// npm run migrate (deployment)
//   Runs any new migration scripts in the updates folder
// 
//   params: 
//   deployment (optional) - name of deployment in deployments.json, defaults to first deployment in deployments.json
function triggerMigrate() {
    const deployments_info = JSON.parse(fs.readFileSync(path.join(__dirname, 'deployments.json'), 'utf8'));
    const selected_deployment = deployments_info[Object.keys(deployments_info)[0]];

    // if deployment is not specified, set selected deployment to first deployment in deployments.json
    if (process.argv[process.argv.indexOf('migrate') + 1] !== undefined) {
        const deployment = process.argv[process.argv.indexOf('migrate') + 1];
        const deployment_info = deployments_info[deployment];
        
        if (deployment_info) {
            selected_deployment = deployment_info;
        } else {
            console.error(`Deployment ${deployment} not found in deployments.json`);
            return;
        }
    }
    
    console.log(`Running migrations on ${selected_deployment.title}...`)
    runDatabaseMigrations(selected_deployment, false);
}

// npm run rebuildViews (deployment)
//   Rebuilds all views in the database
//
//   params:
//   deployment (optional) - name of deployment in deployments.json, defaults to first deployment in deployments.json
function triggerRebuildViews() {
    const deployments_info = JSON.parse(fs.readFileSync(path.join(__dirname, 'deployments.json'), 'utf8'));
    const selected_deployment = deployments_info[Object.keys(deployments_info)[0]];

    // if deployment is not specified, set selected deployment to first deployment in deployments.json
    if (process.argv[process.argv.indexOf('rebuildViews') + 1] !== undefined) {
        const deployment = process.argv[process.argv.indexOf('rebuildViews') + 1];
        const deployment_info = deployments_info[deployment];
        
        if (deployment_info) {
            selected_deployment = deployment_info;
        } else {
            console.error(`Deployment ${deployment} not found in deployments.json`);
            return;
        }
    }

    console.log(`Rebuilding views on ${selected_deployment.title}...`)
    rebuildViews(selected_deployment);
}

// npm run anonymise (deployment)
//   Anonymises the database
//
//   params:
//   deployment (optional) - name of deployment in deployments.json, defaults to first deployment in deployments.json
function triggerAnonymise() {
    const deployments_info = JSON.parse(fs.readFileSync(path.join(__dirname, 'deployments.json'), 'utf8'));
    const selected_deployment = deployments_info[Object.keys(deployments_info)[0]];

    // if deployment is not specified, set selected deployment to first deployment in deployments.json
    if (process.argv[process.argv.indexOf('anonymise') + 1] !== undefined) {
        const deployment = process.argv[process.argv.indexOf('anonymise') + 1];
        const deployment_info = deployments_info[deployment];
        
        if (deployment_info) {
            selected_deployment = deployment_info;
        } else {
            console.error(`Deployment ${deployment} not found in deployments.json`);
            return;
        }
    }

    console.log(`Anonymising ${selected_deployment.title}...`)
    anonymiseDatabase(selected_deployment);
}

module.exports = {
    migrate: triggerMigrate,
    rebuildViews: triggerRebuildViews,
    anonymise: triggerAnonymise
};

require('make-runnable/custom')({
    printOutputFrame: false
})