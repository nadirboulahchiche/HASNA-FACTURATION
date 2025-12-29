/**
 * HASNA License Server
 * Serveur de gestion des licences pour MINOTERIE EL HASNA
 * 
 * Auteur: Digital Glimpse (7ado9)
 * Date: Décembre 2024
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Database connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// ============== INITIALISATION DE LA BASE ==============
async function initDatabase() {
    const client = await pool.connect();
    try {
        // Table des licences
        await client.query(`
            CREATE TABLE IF NOT EXISTS licenses (
                id SERIAL PRIMARY KEY,
                license_key VARCHAR(50) UNIQUE NOT NULL,
                client_name VARCHAR(255) NOT NULL,
                client_email VARCHAR(255),
                machine_id VARCHAR(255),
                activated_at TIMESTAMP,
                expires_at DATE NOT NULL,
                is_active BOOLEAN DEFAULT true,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                notes TEXT
            )
        `);

        // Table des logs d'activation
        await client.query(`
            CREATE TABLE IF NOT EXISTS activation_logs (
                id SERIAL PRIMARY KEY,
                license_key VARCHAR(50) NOT NULL,
                machine_id VARCHAR(255) NOT NULL,
                ip_address VARCHAR(45),
                action VARCHAR(20) NOT NULL,
                success BOOLEAN NOT NULL,
                message TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        console.log('✅ Database initialized successfully');
    } catch (err) {
        console.error('❌ Database initialization error:', err);
    } finally {
        client.release();
    }
}

// ============== ROUTES ==============

// Health check
app.get('/', (req, res) => {
    res.json({ 
        status: 'ok', 
        service: 'HASNA License Server',
        version: '1.0.0'
    });
});

// ============== ACTIVATION DE LICENCE ==============
app.post('/api/license/activate', async (req, res) => {
    const { license_key, machine_id } = req.body;
    const ip_address = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    // Validation
    if (!license_key || !machine_id) {
        return res.status(400).json({
            success: false,
            message: 'Clé de licence et identifiant machine requis'
        });
    }

    const client = await pool.connect();
    try {
        // Chercher la licence
        const result = await client.query(
            'SELECT * FROM licenses WHERE license_key = $1',
            [license_key.toUpperCase().trim()]
        );

        if (result.rows.length === 0) {
            // Log échec
            await logActivation(client, license_key, machine_id, ip_address, 'ACTIVATE', false, 'Clé invalide');
            return res.status(404).json({
                success: false,
                message: 'Clé de licence invalide'
            });
        }

        const license = result.rows[0];

        // Vérifier si active
        if (!license.is_active) {
            await logActivation(client, license_key, machine_id, ip_address, 'ACTIVATE', false, 'Licence désactivée');
            return res.status(403).json({
                success: false,
                message: 'Cette licence a été désactivée'
            });
        }

        // Vérifier expiration
        const today = new Date();
        const expiresAt = new Date(license.expires_at);
        if (today > expiresAt) {
            await logActivation(client, license_key, machine_id, ip_address, 'ACTIVATE', false, 'Licence expirée');
            return res.status(403).json({
                success: false,
                message: 'Cette licence a expiré le ' + expiresAt.toLocaleDateString('fr-FR')
            });
        }

        // Vérifier si déjà activée sur une autre machine
        if (license.machine_id && license.machine_id !== machine_id) {
            await logActivation(client, license_key, machine_id, ip_address, 'ACTIVATE', false, 'Déjà activée sur autre machine');
            return res.status(403).json({
                success: false,
                message: 'Cette licence est déjà activée sur un autre ordinateur. Contactez le support pour la transférer.'
            });
        }

        // Activer la licence
        if (!license.machine_id) {
            await client.query(
                'UPDATE licenses SET machine_id = $1, activated_at = CURRENT_TIMESTAMP WHERE license_key = $2',
                [machine_id, license_key.toUpperCase().trim()]
            );
        }

        // Log succès
        await logActivation(client, license_key, machine_id, ip_address, 'ACTIVATE', true, 'Activation réussie');

        // Calculer jours restants
        const daysRemaining = Math.ceil((expiresAt - today) / (1000 * 60 * 60 * 24));

        res.json({
            success: true,
            message: 'Licence activée avec succès',
            data: {
                client_name: license.client_name,
                expires_at: license.expires_at,
                days_remaining: daysRemaining
            }
        });

    } catch (err) {
        console.error('Activation error:', err);
        res.status(500).json({
            success: false,
            message: 'Erreur serveur lors de l\'activation'
        });
    } finally {
        client.release();
    }
});

// ============== VÉRIFICATION DE LICENCE ==============
app.post('/api/license/verify', async (req, res) => {
    const { license_key, machine_id } = req.body;

    if (!license_key || !machine_id) {
        return res.status(400).json({
            success: false,
            message: 'Clé de licence et identifiant machine requis'
        });
    }

    const client = await pool.connect();
    try {
        const result = await client.query(
            'SELECT * FROM licenses WHERE license_key = $1 AND machine_id = $2',
            [license_key.toUpperCase().trim(), machine_id]
        );

        if (result.rows.length === 0) {
            return res.json({
                success: false,
                valid: false,
                message: 'Licence non trouvée ou machine non autorisée'
            });
        }

        const license = result.rows[0];
        const today = new Date();
        const expiresAt = new Date(license.expires_at);
        const isValid = license.is_active && today <= expiresAt;
        const daysRemaining = Math.ceil((expiresAt - today) / (1000 * 60 * 60 * 24));

        res.json({
            success: true,
            valid: isValid,
            data: {
                client_name: license.client_name,
                expires_at: license.expires_at,
                days_remaining: daysRemaining,
                is_active: license.is_active
            }
        });

    } catch (err) {
        console.error('Verify error:', err);
        res.status(500).json({
            success: false,
            message: 'Erreur serveur'
        });
    } finally {
        client.release();
    }
});

// ============== ADMIN: CRÉER UNE LICENCE ==============
app.post('/api/admin/license/create', async (req, res) => {
    const { admin_key, client_name, client_email, expires_at, notes } = req.body;

    // Vérification admin (simple)
    if (admin_key !== process.env.ADMIN_KEY) {
        return res.status(401).json({
            success: false,
            message: 'Accès non autorisé'
        });
    }

    if (!client_name || !expires_at) {
        return res.status(400).json({
            success: false,
            message: 'Nom du client et date d\'expiration requis'
        });
    }

    // Générer une clé de licence unique
    const license_key = generateLicenseKey();

    const client = await pool.connect();
    try {
        await client.query(
            `INSERT INTO licenses (license_key, client_name, client_email, expires_at, notes)
             VALUES ($1, $2, $3, $4, $5)`,
            [license_key, client_name, client_email, expires_at, notes]
        );

        res.json({
            success: true,
            message: 'Licence créée avec succès',
            data: {
                license_key,
                client_name,
                expires_at
            }
        });

    } catch (err) {
        console.error('Create license error:', err);
        res.status(500).json({
            success: false,
            message: 'Erreur lors de la création de la licence'
        });
    } finally {
        client.release();
    }
});

// ============== ADMIN: LISTE DES LICENCES ==============
app.get('/api/admin/licenses', async (req, res) => {
    const admin_key = req.headers['x-admin-key'];

    if (admin_key !== process.env.ADMIN_KEY) {
        return res.status(401).json({
            success: false,
            message: 'Accès non autorisé'
        });
    }

    const client = await pool.connect();
    try {
        const result = await client.query(
            'SELECT * FROM licenses ORDER BY created_at DESC'
        );

        res.json({
            success: true,
            data: result.rows
        });

    } catch (err) {
        console.error('List licenses error:', err);
        res.status(500).json({
            success: false,
            message: 'Erreur serveur'
        });
    } finally {
        client.release();
    }
});

// ============== ADMIN: RÉINITIALISER MACHINE ==============
app.post('/api/admin/license/reset-machine', async (req, res) => {
    const { admin_key, license_key } = req.body;

    if (admin_key !== process.env.ADMIN_KEY) {
        return res.status(401).json({
            success: false,
            message: 'Accès non autorisé'
        });
    }

    const client = await pool.connect();
    try {
        const result = await client.query(
            'UPDATE licenses SET machine_id = NULL WHERE license_key = $1 RETURNING *',
            [license_key.toUpperCase().trim()]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Licence non trouvée'
            });
        }

        res.json({
            success: true,
            message: 'Machine réinitialisée. La licence peut être activée sur un nouveau PC.'
        });

    } catch (err) {
        console.error('Reset machine error:', err);
        res.status(500).json({
            success: false,
            message: 'Erreur serveur'
        });
    } finally {
        client.release();
    }
});

// ============== HELPERS ==============

function generateLicenseKey() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const segments = [];
    for (let s = 0; s < 4; s++) {
        let segment = '';
        for (let i = 0; i < 4; i++) {
            segment += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        segments.push(segment);
    }
    return 'HASNA-' + segments.join('-');
}

async function logActivation(client, license_key, machine_id, ip_address, action, success, message) {
    try {
        await client.query(
            `INSERT INTO activation_logs (license_key, machine_id, ip_address, action, success, message)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [license_key, machine_id, ip_address, action, success, message]
        );
    } catch (err) {
        console.error('Log error:', err);
    }
}

// ============== START SERVER ==============
initDatabase().then(() => {
    app.listen(PORT, () => {
        console.log(`🚀 HASNA License Server running on port ${PORT}`);
    });
});
