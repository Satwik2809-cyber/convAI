const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx'); // Use the xlsx library for Excel file parsing
const csv = require('csv-parse/sync'); // Use csv-parse/sync for synchronous CSV parsing

const config = require('../utils/config'); // Assuming config is available
const logger = require('../utils/logger');

const ACTOR_RELATIONSHIP_FILE_XLSX = 'actors_relationships.xlsx';
const ACTOR_RELATIONSHIP_FILE_CSV = 'actors_relationships.csv';

class RelationshipService {
  constructor() {
    this.actorMap = new Map(); // Maps actor_id to { id, type, role }
    this.relationshipMap = new Map(); // Maps actor_id to { relationship_type: [target_actor_id, ...] }

    // Load data on initialization
    this.loadData().catch(err => {
      logger.error('Failed to load relationship data on initialization', { error: err.message });
    });
  }

  async loadData() {
    const filePath = path.join(config.dataDir || './data', 'student_health_dataset.json');

    let data;
    try {
      const fileContent = await fs.promises.readFile(filePath, 'utf8');
      data = JSON.parse(fileContent);
      this.rawDataset = data; // Retain the raw dataset for reporting
      logger.info(`🚀 Relationship data loaded from JSON: ${filePath}`);
    } catch (error) {
      logger.error('Error loading student_health_dataset.json:', { filePath, error: error.message });
      throw error;
    }

    this.actorMap.clear();
    this.relationshipMap.clear();

    const students = data.Students || [];
    const parents = data.Parents || [];
    const teachers = data.Teachers || [];
    const admins = data.Admins || [];
    const mappings = data.Mappings || [];

    // 1. Map Students
    students.forEach(s => {
      const id = s.StudentName; // Using Name as the key for identity verification
      this.actorMap.set(id, { id, studentId: s.StudentId, type: 'student', roles: ['student'], role: 'student' });
    });

    // 2. Map Parents
    parents.forEach(p => {
      const id = p.ParentName;
      if (!this.actorMap.has(id)) {
        this.actorMap.set(id, { id, roles: [], type: 'parent' });
      }
      const actor = this.actorMap.get(id);
      if (!actor.roles.includes('parent')) {
        actor.roles.push('parent');
        // Set default role/type to the first one encountered if not set
        if (!actor.role) actor.role = 'parent';
      }
      
      // Relationship: Parent -> HAS_CHILD -> Student Name
      const student = students.find(s => s.StudentId === p.StudentId);
      if (student) {
        if (!this.relationshipMap.has(id)) this.relationshipMap.set(id, {});
        const rels = this.relationshipMap.get(id);
        if (!rels['HAS_CHILD']) rels['HAS_CHILD'] = [];
        rels['HAS_CHILD'].push(student.StudentName);
      }
    });

    // 3. Map Teachers
    teachers.forEach(t => {
      const id = t.TeacherName;
      if (!this.actorMap.has(id)) {
        this.actorMap.set(id, { id, roles: [], type: 'teacher' });
      }
      const actor = this.actorMap.get(id);
      if (!actor.roles.includes('teacher')) {
        actor.roles.push('teacher');
        if (!actor.role) actor.role = 'teacher';
      }
      
      // Find students via Mappings
      const studentIds = mappings.filter(m => m.TeacherId === t.TeacherId).map(m => m.StudentId);
      studentIds.forEach(sid => {
        const student = students.find(s => s.StudentId === sid);
        if (student) {
          if (!this.relationshipMap.has(id)) this.relationshipMap.set(id, {});
          const rels = this.relationshipMap.get(id);
          if (!rels['TEACHES']) rels['TEACHES'] = [];
          rels['TEACHES'].push(student.StudentName);
        }
      });
    });

    // 4. Map Admins
    admins.forEach(a => {
      const id = a.Name;
      let specificRole = 'admin';
      if (a.Role) {
        specificRole = a.Role.toLowerCase().replace(/[\s\/]+/g, '_'); // e.g., "principal", "medical_admin", "school_admin", "principal_admin"
        if (specificRole === 'principal_admin') specificRole = 'admin';
      }

      if (!this.actorMap.has(id)) {
        this.actorMap.set(id, { id, roles: [], type: specificRole });
      }
      const actor = this.actorMap.get(id);
      if (!actor.roles.includes(specificRole)) {
        actor.roles.push(specificRole);
        if (!actor.role) actor.role = specificRole;
      }

      // Admins are mapped to students in Mappings (AdminIds is a comma-separated string)
      mappings.forEach(m => {
        if (m.AdminIds && m.AdminIds.split(',').includes(a.AdminId)) {
          const student = students.find(s => s.StudentId === m.StudentId);
          if (student) {
            if (!this.relationshipMap.has(id)) this.relationshipMap.set(id, {});
            const rels = this.relationshipMap.get(id);
            if (!rels['ADMINISTERS']) rels['ADMINISTERS'] = [];
            rels['ADMINISTERS'].push(student.StudentName);
          }
        }
      });
    });
    
    logger.info(`🚀 Relationship data processed: ${this.actorMap.size} actors, ${this.relationshipMap.size} relationship sources.`);
    this.relationships = { actorMap: this.actorMap, relationshipMap: this.relationshipMap };

    // Push to OPA for centralized policy evaluation
    const policyService = require('./policyService');
    // For OPA sync, we'll pass a structured object that OPA expects or just the raw data
    // The current policyService.syncRelationshipData expects 'records' which it then parses.
    // I should probably update policyService.syncRelationshipData to handle this JSON structure.
    policyService.syncRelationshipData(data).catch(err => {
      logger.error('🛡️ Deferred OPA sync failed', { error: err.message });
    });
  }

  /**
   * Ensures data is loaded before performing operations.
   * Reloads if data is not yet loaded.
   */
  async ensureDataLoaded() {
    if (!this.relationships) { // Load if not loaded
      await this.loadData();
    }
  }

  /**
   * Get information about an actor by their ID.
   * @param {string} actorId - The ID of the actor.
   * @returns {object | null} - Actor info { id, type, role } or null if not found.
   */
  getActorInfo(actorId) {
    return this.actorMap.get(actorId) || null;
  }

  /**
   * Get all relationships originating from a specific actor.
   * @param {string} actorId - The ID of the source actor.
   * @returns {object | null} - Object mapping relationship types to arrays of target actor IDs, or null if no relationships found.
   */
  getRelationships(actorId) {
    return this.relationshipMap.get(actorId) || null;
  }

  /**
   * Check if a specific relationship exists between two actors.
   * @param {string} sourceActorId - The ID of the source actor.
   * @param {string} relationshipType - The type of relationship to check.
   * @param {string} targetActorId - The ID of the target actor.
   * @returns {boolean} - True if the relationship exists, false otherwise.
   */
  hasRelationship(sourceActorId, relationshipType, targetActorId) {
    const relationships = this.getRelationships(sourceActorId);
    if (!relationships) return false;
    
    const targets = relationships[relationshipType];
    if (!targets) return false;

    return targets.includes(targetActorId);
  }
  
  /**
   * Check if an actor has a specific type.
   * @param {string} actorId - The ID of the actor.
   * @param {string} actorType - The type to check against.
   * @returns {boolean} - True if the actor has the specified type, false otherwise.
   */
  hasActorType(actorId, actorType) {
      const actor = this.getActorInfo(actorId);
      return actor ? actor.type === actorType : false;
  }

  validateIdentity(userName, studentName, requestedRole = null) {
    if (!userName || !studentName) return null;

    const uName = userName.trim().toLowerCase();
    const sName = studentName.trim().toLowerCase();

    // Iterate through all actors to find the student first
    for (const [id, info] of this.actorMap.entries()) {
      if (info.type === 'student' && (id.toLowerCase() === sName || sName.includes(id.toLowerCase()))) {
        // Found the student. Now check their relationships.
        
        // Let's iterate over the relationshipMap
        for (const [sourceId, rels] of this.relationshipMap.entries()) {
          for (const relType in rels) {
            if (rels[relType].includes(id)) {
              // Found a person related to this student.
              // Check if the sourceId (name) matches the userName
              const dbSourceId = sourceId.toLowerCase();
              
              // Helper for simple Levenshtein distance to allow minor typos (like Tondon vs Tandon)
              const getDistance = (a, b) => {
                const matrix = Array(b.length + 1).fill(null).map(() => Array(a.length + 1).fill(null));
                for (let i = 0; i <= a.length; i++) matrix[0][i] = i;
                for (let j = 0; j <= b.length; j++) matrix[j][0] = j;
                for (let j = 1; j <= b.length; j++) {
                  for (let i = 1; i <= a.length; i++) {
                    const indicator = a[i - 1] === b[j - 1] ? 0 : 1;
                    matrix[j][i] = Math.min(
                      matrix[j][i - 1] + 1,
                      matrix[j - 1][i] + 1,
                      matrix[j - 1][i - 1] + indicator
                    );
                  }
                }
                return matrix[b.length][a.length];
              };

              // Accept exact match, substring match, or fuzzy match (allow 2 typos for names > 5 chars)
              const isFuzzyMatch = dbSourceId.length > 5 && getDistance(dbSourceId, uName) <= 2;
              
              if (dbSourceId === uName || uName.includes(dbSourceId) || isFuzzyMatch) {
                // Match! Return the role based on the relationship type
                let matchedRole = 'guest';
                if (relType === 'HAS_CHILD') matchedRole = 'parent';
                else if (relType === 'TEACHES') matchedRole = 'teacher';
                else if (relType === 'ADMINISTERS') {
                  const sourceActor = this.actorMap.get(sourceId);
                  matchedRole = sourceActor && sourceActor.role ? sourceActor.role : 'admin';
                }
                else if (relType === 'HEADS') matchedRole = 'head';

                // If a specific role was requested, ensure it matches
                if (requestedRole && matchedRole !== requestedRole) {
                  continue; // Keep searching for the correct relationship type
                }

                return {
                  role: matchedRole,
                  studentName: id,
                  studentId: id
                };
              }
            }
          }
        }
      }
    }

    return null;
  }

  /**
   * Find the closest matching actor name using Levenshtein distance.
   * Useful for AWAITING_NAME state.
   */
  findClosestActor(name) {
    if (!name) return null;
    const target = name.trim().toLowerCase();
    
    // Check for exact or substring match first
    for (const [id, info] of this.actorMap.entries()) {
      if (info.type === 'student') continue; // only match parents/teachers/admins
      if (id.toLowerCase() === target || target.includes(id.toLowerCase())) {
        return { name: id, exact: true };
      }
    }

    // Fuzzy match if no exact/substring match
    const getDistance = (a, b) => {
      const matrix = Array(b.length + 1).fill(null).map(() => Array(a.length + 1).fill(null));
      for (let i = 0; i <= a.length; i++) matrix[0][i] = i;
      for (let j = 0; j <= b.length; j++) matrix[j][0] = j;
      for (let j = 1; j <= b.length; j++) {
        for (let i = 1; i <= a.length; i++) {
          const indicator = a[i - 1] === b[j - 1] ? 0 : 1;
          matrix[j][i] = Math.min(
            matrix[j][i - 1] + 1,
            matrix[j - 1][i] + 1,
            matrix[j - 1][i - 1] + indicator
          );
        }
      }
      return matrix[b.length][a.length];
    };

    let bestMatch = null;
    let minDistance = Infinity;

    for (const [id, info] of this.actorMap.entries()) {
      if (info.type === 'student') continue;
      
      const dbName = id.toLowerCase();
      // Heuristic: only compare if lengths are somewhat similar
      if (Math.abs(dbName.length - target.length) > 3) continue;

      const dist = getDistance(dbName, target);
      if (dist < minDistance) {
        minDistance = dist;
        bestMatch = id;
      }
    }

    // Allow up to 3 typos
    if (bestMatch && minDistance <= 3) {
      return { name: bestMatch, exact: false, distance: minDistance };
    }

    return null;
  }
}

// Export a singleton instance
// Ensure 'xlsx', 'csv-parse/sync', 'fs', 'path' are available.
module.exports = new RelationshipService();
