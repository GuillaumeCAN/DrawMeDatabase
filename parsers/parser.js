const fs = require('fs');
const path = require('path');

const hasFiles = (projectPath, files) => {
    return files.every(file => fs.existsSync(path.join(projectPath, file)));
};

// Main function to detect the framework
module.exports.detectFramework = function(projectPath){

    // Laravel detection
    if (hasFiles(projectPath, ['artisan', 'composer.json'])) {
        const composerPath = path.join(projectPath, 'composer.json');
        const composerData = JSON.parse(fs.readFileSync(composerPath, 'utf8'));
        if (composerData.require && composerData.require['laravel/framework']) {
            return 'laravel';
        }
    }

    // Symfony detection
    if (hasFiles(projectPath, ['bin/console', 'composer.json'])) {
        const composerPath = path.join(projectPath, 'composer.json');
        const composerData = JSON.parse(fs.readFileSync(composerPath, 'utf8'));
        if (composerData.require && Object.keys(composerData.require).some(dep => dep.startsWith('symfony/'))) {
            return 'symfony';
        }
    }

    // Django detection
    if (hasFiles(projectPath, ['manage.py'])) {
        const requirementsPath = path.join(projectPath, 'requirements.txt');
        const pyprojectPath = path.join(projectPath, 'pyproject.toml');

        if (fs.existsSync(requirementsPath)) {
            const requirements = fs.readFileSync(requirementsPath, 'utf8');
            if (requirements.includes('Django')) {
                return 'django';
            }
        } else if (fs.existsSync(pyprojectPath)) {
            const pyproject = fs.readFileSync(pyprojectPath, 'utf8');
            if (pyproject.toLowerCase().includes('django')) {
                return 'django';
            }
        }
    }

    return 'Unknown';
};