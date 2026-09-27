/**
 * ConvAI — Identity Service
 *
 * Manages the multi-turn conversational flow for verifying user identity
 * against the relationship data (JSON dataset).
 *
 * Flow:
 *   NONE → (auto-greeting) → AWAITING_NAME
 *   AWAITING_NAME → (name matched) → AWAITING_STUDENT_NAME  [for parent/teacher]
 *                                  → VERIFIED               [for admin/principal]
 *   AWAITING_STUDENT_NAME → (relationship verified) → VERIFIED
 */

const logger = require('../utils/logger');
const relationshipService = require('./relationshipService');

// Admin-level roles that do NOT need student name verification
const ADMIN_ROLES = ['admin', 'principal', 'school_admin', 'medical_admin'];

class IdentityService {
  constructor() {
    this.STATES = {
      NONE: 'NONE',
      AWAITING_NAME: 'AWAITING_NAME',
      AWAITING_STUDENT_NAME: 'AWAITING_STUDENT_NAME',
      VERIFIED: 'VERIFIED',
    };
  }

  /** Check if a session is currently verified. */
  isVerified(session) {
    return session.identity && session.identity.state === this.STATES.VERIFIED;
  }

  /** Initialize identity state for a new session if not present. */
  ensureIdentityState(session) {
    if (!session.identity) {
      session.identity = {
        state: this.STATES.NONE,
        name: null,
        studentName: null,
        role: null,
        verifiedAt: null,
      };
    }
  }

  /**
   * Returns the initial greeting that ConvAI sends at the start of every new session.
   * This is called by interactionService when a fresh session is detected.
   */
  getGreeting() {
    return (
      "👋 Welcome to **ConvAI** — your policy-governed AI assistant for school health, " +
      "attendance, and grievances.\n\n" +
      "To get started, could you please tell me **your full name**? " +
      "I'll verify your identity and tailor my responses to your role."
    );
  }

  /**
   * Process a message specifically for the identity flow.
   *
   * @param {string} text - User message
   * @param {object} session - User session
   * @returns {string} - Next question for user, or null if verification complete (proceed to LLM).
   */
  handleVerification(text, session) {
    this.ensureIdentityState(session);
    const state = session.identity.state;
    const input = text.trim();

    switch (state) {
      case this.STATES.NONE:
        // Session just started — ask for name
        session.identity.state = this.STATES.AWAITING_NAME;
        return this.getGreeting();

      case this.STATES.AWAITING_NAME: {
        const greetings = ['hi', 'hello', 'hey', 'greetings', 'hi there'];
        if (greetings.includes(input.toLowerCase())) {
          return "Hello! I am ConvAI. To get started and personalize your experience, could you please tell me your full name as registered in the school?";
        }

        const match = relationshipService.findClosestActor(input);

        if (!match) {
          return (
            "I'm sorry, I couldn't find a record matching **\"" + input + "\"** in our system. " +
            "Could you please check your spelling and try again? " +
            "(Make sure to enter your full name as registered in the school.)"
          );
        }

        session.identity.name = match.name;

        // Find the actor's role
        const actorInfo = relationshipService.getActorInfo(match.name);
        const detectedRole = actorInfo ? (actorInfo.role || actorInfo.type) : 'guest';
        session.identity.role = detectedRole;
        session.userRole = detectedRole;

        const nameNote = match.exact
          ? `Thanks, **${match.name}**!`
          : `Thanks! I found the closest match: **${match.name}** — I'll use that.`;

        if (detectedRole === 'parent') {
          const rels = relationshipService.getRelationships(match.name);
          const children = (rels && rels['HAS_CHILD']) ? rels['HAS_CHILD'] : [];
          
          if (children.length === 1) {
            session.authorizedStudentNames = children;
            session.currentTargetStudent = children[0];
            session.identity.state = this.STATES.VERIFIED;
            session.identity.verifiedAt = new Date().toISOString();
            return `${nameNote}\n\n✅ Identity verified! Welcome, **Parent**! I see you are the parent of **${children[0]}**. How can I help you today?`;
          } else if (children.length > 1) {
            session.authorizedStudentNames = children;
            session.identity.state = this.STATES.AWAITING_STUDENT_NAME;
            return `${nameNote}\n\nI found multiple children linked to your account: **${children.join(', ')}**. Which child would you like information for?`;
          }
        }

        session.identity.state = this.STATES.VERIFIED;
        session.identity.verifiedAt = new Date().toISOString();
        const roleDisplay = this._formatRole(detectedRole);
        return (
          `${nameNote}\n\n` +
          `✅ Identity verified! Welcome, **${roleDisplay}**! How can I help you today?`
        );
      }

      case this.STATES.AWAITING_STUDENT_NAME: {
        const children = session.authorizedStudentNames || [];
        const lowerInput = input.toLowerCase();
        let matchedChild = null;
        for (const child of children) {
           if (child.toLowerCase().includes(lowerInput) || lowerInput.includes(child.toLowerCase())) {
               matchedChild = child;
               break;
           }
        }
        
        if (matchedChild) {
            session.currentTargetStudent = matchedChild;
            session.identity.state = this.STATES.VERIFIED;
            session.identity.verifiedAt = new Date().toISOString();
            return `Got it. I've selected **${matchedChild}**. How can I help you regarding their health or attendance?`;
        } else {
            return `I'm sorry, I couldn't match "${input}" to your authorized children: **${children.join(', ')}**. Please specify which one.`;
        }
      }

      case this.STATES.VERIFIED: {
        const match = relationshipService.findClosestActor(input);
        if (match) {
            const actorInfo = relationshipService.getActorInfo(match.name);
            const detectedRole = actorInfo ? (actorInfo.role || actorInfo.type) : 'guest';
            
            if (session.identity.role === 'parent' && detectedRole === 'parent' && session.identity.name !== match.name) {
                // New parent name entered!
                session.identity.name = match.name;
                session.identity.role = 'parent';
                session.userRole = 'parent';
                session.currentTargetStudent = null;
                session.authorizedStudentNames = null;
                
                const rels = relationshipService.getRelationships(match.name);
                const children = (rels && rels['HAS_CHILD']) ? rels['HAS_CHILD'] : [];
                
                if (children.length === 1) {
                    session.authorizedStudentNames = children;
                    session.currentTargetStudent = children[0];
                    session.identity.state = this.STATES.VERIFIED;
                    session.identity.verifiedAt = new Date().toISOString();
                    return `Parent identity updated. Previous verification cleared. Auto-verified student access for **${children[0]}**.`;
                } else if (children.length > 1) {
                    session.authorizedStudentNames = children;
                    session.identity.state = this.STATES.AWAITING_STUDENT_NAME;
                    return `Parent identity updated. Previous verification cleared. Please verify student access again by selecting a child: **${children.join(', ')}**`;
                } else {
                    session.identity.state = this.STATES.VERIFIED;
                    return `Parent identity updated. Previous verification cleared.`;
                }
            }
        }
        
        // Otherwise, reset entirely if they want to re-verify
        session.identity.state = this.STATES.AWAITING_NAME;
        session.identity.name = null;
        session.identity.studentName = null;
        session.currentTargetStudent = null;
        session.authorizedStudentNames = null;
        return "Identity reset requested. " + this.getGreeting();
      }

      default:
        return null;
    }
  }

  /** Perform the final dataset lookup and update state. */
  _verify(session) {
    const result = relationshipService.validateIdentity(
      session.identity.name,
      session.identity.studentName,
      session.identity.role
    );

    if (result) {
      session.identity.state = this.STATES.VERIFIED;
      session.identity.role = result.role;
      session.identity.verifiedAt = new Date().toISOString();
      session.userRole = result.role;

      // Store student context for RAG
      session.currentTargetStudent = result.studentName;

      const roleDisplay = this._formatRole(result.role);
      return (
        `✅ **Identity Verified!**\n\n` +
        `Welcome, **${roleDisplay} ${session.identity.name}**! ` +
        `I've confirmed your relationship with **${result.studentName}**.\n\n` +
        `You can now ask me about:\n` +
        `• 🏥 **Health reports** — medical findings, BMI, dental, vision\n` +
        `• 📋 **Attendance** — records, absences, leave summaries\n` +
        `• 📊 **Trends** — progress over time (benchmarking available)\n` +
        `• 📝 **Grievances** — file or check the status of a complaint\n\n` +
        `All responses are governed by school policy. How can I help you?`
      );
    }

    // Failed verification — give another chance
    session.identity.state = this.STATES.AWAITING_STUDENT_NAME;
    return (
      "I'm sorry, I couldn't find a relationship between **" + session.identity.name +
      "** and a student named **\"" + session.identity.studentName + "\"** in our records. " +
      "Please double-check the student's full name and try again."
    );
  }

  /**
   * Handle role switching for an existing session.
   * Forces re-verification for the new role.
   */
  switchRole(session, newRole) {
    if (session.identity) {
      session.identity.role = newRole;
      session.identity.name = null;
      session.identity.studentName = null;
      session.currentTargetStudent = null;
      session.authorizedStudentNames = null;
      session.identity.state = this.STATES.AWAITING_NAME;
    }
  }

  /**
   * Check if the current intent requires identity verification.
   */
  requiresVerification(intent) {
    const sensitiveIntents = [
      'ViewHealthReport',
      'AskAttendance',
      'AssignAndReviewExercise',
      'BenchmarkAgainstAggregate',
      'ViewTrendOverTime',
      'FileGrievance',
      'ViewGrievanceStatus',
    ];
    return sensitiveIntents.includes(intent);
  }

  /** Format a role string for display. */
  _formatRole(role) {
    if (!role) return 'User';
    return role
      .split('_')
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  }
}

module.exports = new IdentityService();
