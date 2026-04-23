/**
 * Connection Manager - Handles SSH connection profiles and connections
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
   * Connect to a server using a profile
   */
  async connect(profile) {
    try {
      const result = await window.termulAPI.ssh.connect(profile);
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
   * Disconnect from current server
   */
  async disconnect() {
    if (this.connectionId) {
      await window.termulAPI.ssh.disconnect(this.connectionId);
      this.currentConnection = null;
      this.connectionId = null;
      if (this.onDisconnected) {
        this.onDisconnected();
      }
    }
  }

  /**
   * Generate a unique ID for profiles
   */
  generateId() {
    return 'prof_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 9);
  }

  /**
   * Create a new blank profile
   */
  createBlankProfile() {
    return {
      id: this.generateId(),
      name: '',
      host: '',
      port: 22,
      username: '',
      authType: 'password',
      password: '',
      privateKey: '',
      passphrase: '',
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
