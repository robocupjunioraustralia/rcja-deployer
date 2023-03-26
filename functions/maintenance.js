const fs = require('fs');
const path = require('path');

function enableMaintenance(selected_deployment) {
    const maintenanceFile = path.join(selected_deployment.path, 'MAINTENANCE');
    fs.writeFile(maintenanceFile, 'MAINTENANCE', (err) => {
        if (err) {
            console.error(err);
        } else {
            console.log('[DEPLOYER] Maintenance mode enabled');
        }
    });
}

function disableMaintenance(selected_deployment) {
    const maintenanceFile = path.join(selected_deployment.path, 'MAINTENANCE');
    if (fs.existsSync(maintenanceFile)) {
        fs.unlink(maintenanceFile, (err) => {
            if (err) {
                console.error(err);
            } else {
                console.log('[DEPLOYER] Maintenance mode disabled');
            }
        });
    }
}

module.exports = {
    enableMaintenance,
    disableMaintenance,
};