/**
 * Connection Manager - Handles SSH and FTP connection profiles and connections
 */
class ConnectionManager {
  constructor() {
    this.currentConnection = null;
    this.connectionId = null;
    this.onConnected = null;
    this.onDisconnected = null;
  }

  /**
   * Get all saved profiles
   */
  async getProfiles() {
    return window.termulAPI.profiles.getAll();
  }

  /**
   * Save a profile (create or update)
   */
  async saveProfile(profile) {
    if (!profile.id) {
      profile.id = this.generateId();
    }
    profile.updatedAt = new Date().toISOString();
    if (!profile.createdAt) {
      profile.createdAt = profile.updatedAt;
    }
    return window.termulAPI.profiles.save(profile);
  }

  /**
   * Delete a profile
   */
  async deleteProfile(profileId) {
    return window.termulAPI.profiles.delete(profileId);
  }

  /**
   * Connect to a server using a profile.
   * Routes to SSH or FTP based on profile.protocol.
   */
  async connect(profile) {
    const protocol = profile.protocol || 'ssh';
    try {
      let result;
      if (protocol === 'ftp') {
        result = await window.termulAPI.ftp.connect(profile);
      } else {
        result = await window.termulAPI.ssh.connect(profile);
      }
      if (result.success) {
        this.currentConnection = profile;
        this.connectionId = result.connectionId;
        if (this.onConnected) {
          this.onConnected(profile, result.connectionId);
        }
      }
      return result;
    } catch (err) {
      return { success: false, error: err.error || err.message || 'Connection failed' };
    }
  }

  /**
   * Disconnect from current server.
   * Routes to SSH or FTP based on the stored profile's protocol.
   */
  async disconnect() {
    if (this.connectionId) {
      const protocol = (this.currentConnection && this.currentConnection.protocol) || 'ssh';
      if (protocol === 'ftp') {
        await window.termulAPI.ftp.disconnect(this.connectionId);
      } else {
        await window.termulAPI.ssh.disconnect(this.connectionId);
      }
      this.currentConnection = null;
      this.connectionId = null;
      if (this.onDisconnected) {
        this.onDisconnected();
      }
    }
  }

  /**
   * Disconnect a specific connection by ID and protocol.
   * @param {string} connectionId
   * @param {string} protocol - 'ssh' or 'ftp'
   */
  async disconnectById(connectionId, protocol) {
    if (!connectionId) return;
    protocol = protocol || 'ssh';
    if (protocol === 'ftp') {
      await window.termulAPI.ftp.disconnect(connectionId);
    } else {
      await window.termulAPI.ssh.disconnect(connectionId);
    }
  }

  /**
   * Generate a unique ID for profiles
   */
  generateId() {
    return 'prof_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 9);
  }

  /**
   * Create a new blank profile.
   * @param {string} [protocol='ssh'] - 'ssh' or 'ftp'
   */
  createBlankProfile(protocol) {
    protocol = protocol || 'ssh';
    return {
      id: this.generateId(),
      name: '',
      host: '',
      port: protocol === 'ftp' ? 21 : 22,
      username: protocol === 'ftp' ? 'anonymous' : '',
      authType: 'password',
      password: '',
      privateKey: '',
      passphrase: '',
      protocol: protocol,
      color: this.getRandomColor(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  }

  getRandomColor() {
    const colors = [
      '#0078D4', '#0099BC', '#7A7574', '#767676',
      '#FF8C00', '#E81123', '#0063B1', '#6B69D6',
      '#8E562E', '#00B7C3', '#038387', '#00B294'
    ];
    return colors[Math.floor(Math.random() * colors.length)];
  }
}

// Export as singleton
window.ConnectionManager = new ConnectionManager();
