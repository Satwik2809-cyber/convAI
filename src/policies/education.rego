# ===========================================================================
# ConvAI Education Policy
#
# Governs AI responses for the education industry (School Health + Grievance).
# Default: BLOCK (fail-closed).
# ===========================================================================
package conversalx.education

import rego.v1

default decision := "BLOCK"
default reason := "Response blocked by default education policy"
default conditions := []
default rationale_code := ""

# Helper functions to access internal relationship data
relationships := data.conversalx.relationships.actors

actor_id := input.actor_id
target_actor_id := input.target_actor_id

# Determine user role from internal data if not provided or to verify
# Priority: input.user_role (if trusted) OR look up from data
user_role := r if {
    input.user_role != null
    input.user_role != "guest"
    r := input.user_role
} else := r if {
    relationships[input.actor_id]
    r := relationships[input.actor_id].type
} else := "guest"

# Helper to check if an actor is an admin-level role
is_admin_or_head(role) := true if {
    role in ["admin", "head", "principal", "medical_admin", "school_admin"]
}

# Helper to check if a target is a student
is_target_child := true if {
    relationships[input.target_actor_id].type == "student"
}

# Helper to check if the parent has a relationship with the target child
parent_has_child(parent_id, child_id) := true if {
    child_id in relationships[parent_id].relations.has_student
}

# Helper to check if the teacher teaches the target child
teacher_teaches_child(teacher_id, child_id) := true if {
    child_id in relationships[teacher_id].relations.has_student
}

# ── SYSTEM COMMANDS ───────────────────────────────────────────────────────

decision := "PROCEED" if {
    input.intent == "switch_role"
    input.actor_id != null
    relationships[input.actor_id]
    input.target_role == relationships[input.actor_id].type
}

decision := "PROCEED" if {
    input.intent == "identity_verification"
}
rationale_code := "IDENTITY_VERIFICATION_ALLOWED" if {
    input.intent == "identity_verification"
}

decision := "PROCEED" if {
    input.intent == "switch_role"
    not relationships[input.actor_id]
}

decision := "BLOCK" if {
    input.intent == "switch_role"
    input.actor_id != null
    relationships[input.actor_id]
    input.target_role != relationships[input.actor_id].type
}

reason := "User lacks authorization for the requested role" if {
    input.intent == "switch_role"
    input.actor_id != null
    relationships[input.actor_id]
    input.target_role != relationships[input.actor_id].type
}

rationale_code := "ROLE_SWITCH_ALLOWED" if {
    input.intent == "switch_role"
    decision == "PROCEED"
}

# ── SCHOOL HEALTH DOMAIN ──────────────────────────────────────────────────

# Admin/Head catch-all (excluding specific trend/attendance views)
decision := "PROCEED" if {
    is_admin_or_head(user_role)
    not input.intent in ["ViewTrendOverTime", "AskAttendance"]
}

# SH-0: Block parent if they don't specify their child's name
decision := "BLOCK" if {
    input.intent in ["ViewHealthReport", "AskAttendance", "BenchmarkAgainstAggregate", "ViewLearningTrendOverTime"]
    user_role == "parent"
    input.target_actor_id == null
}

reason := "Please specify the name of your child in your request so I know who you are inquiring about." if {
    input.intent in ["ViewHealthReport", "AskAttendance", "BenchmarkAgainstAggregate", "ViewLearningTrendOverTime"]
    user_role == "parent"
    input.target_actor_id == null
}

rationale_code := "PARENT_CHILD_NOT_SPECIFIED" if {
    input.intent in ["ViewHealthReport", "AskAttendance", "BenchmarkAgainstAggregate", "ViewLearningTrendOverTime"]
    user_role == "parent"
    input.target_actor_id == null
}

# SH-1: Parent views child report (health or attendance)
decision := "PROCEED_WITH_CONDITIONS" if {
    input.intent in ["ViewHealthReport", "AskAttendance"]
    user_role == "parent"
    is_target_child
    parent_has_child(actor_id, target_actor_id)
}
conditions := ["summary_view_only", "non_diagnostic_language", "own_child_data_allowed"] if {
    input.intent in ["ViewHealthReport", "AskAttendance"]
    user_role == "parent"
    is_target_child
    parent_has_child(actor_id, target_actor_id)
}
rationale_code := "OWN_CHILD_DATA_ALLOWED" if {
    input.intent in ["ViewHealthReport", "AskAttendance"]
    user_role == "parent"
    is_target_child
    parent_has_child(actor_id, target_actor_id)
}

# SH-2: Parent benchmarks child
decision := "PROCEED_WITH_CONDITIONS" if {
    input.intent == "BenchmarkAgainstAggregate"
    user_role == "parent"
    is_target_child
    parent_has_child(actor_id, target_actor_id)
}
conditions := ["aggregate_only", "anonymised_only", "no_medical_inference"] if {
    input.intent == "BenchmarkAgainstAggregate"
    user_role == "parent"
    is_target_child
    parent_has_child(actor_id, target_actor_id)
}
rationale_code := "AGGREGATE_BENCHMARK_ALLOWED" if {
    input.intent == "BenchmarkAgainstAggregate"
    user_role == "parent"
    is_target_child
    parent_has_child(actor_id, target_actor_id)
}

# SH-3: Teacher checks student flags (health or attendance)
decision := "PROCEED_WITH_CONDITIONS" if {
    input.intent in ["ViewHealthReport", "AskAttendance"]
    user_role == "teacher"
    is_target_child
    teacher_teaches_child(actor_id, target_actor_id)
}
conditions := ["high_level_only", "no_medical_detail", "teacher_restricted_data_allowed"] if {
    input.intent in ["ViewHealthReport", "AskAttendance"]
    user_role == "teacher"
    is_target_child
    teacher_teaches_child(actor_id, target_actor_id)
}
rationale_code := "TEACHER_RESTRICTED_DATA_ALLOWED" if {
    input.intent in ["ViewHealthReport", "AskAttendance"]
    user_role == "teacher"
    is_target_child
    teacher_teaches_child(actor_id, target_actor_id)
}

# SH-3b: Teacher checks class flags (health or attendance) without specifying a student
decision := "PROCEED_WITH_CONDITIONS" if {
    input.intent in ["ViewHealthReport", "AskAttendance"]
    user_role == "teacher"
    input.target_actor_id == null
}
conditions := ["high_level_only", "no_medical_detail"] if {
    input.intent in ["ViewHealthReport", "AskAttendance"]
    user_role == "teacher"
    input.target_actor_id == null
}
rationale_code := "TEACHER_CLASS_OVERVIEW_ALLOWED" if {
    input.intent in ["ViewHealthReport", "AskAttendance"]
    user_role == "teacher"
    input.target_actor_id == null
}

# SH-4: Admin analyses trends or attendance
decision := "PROCEED_WITH_CONDITIONS" if {
    input.intent in ["ViewTrendOverTime", "AskAttendance"]
    is_admin_or_head(user_role)
}
conditions := ["descriptive_only", "no_prediction", "admin_trend_access_allowed"] if {
    input.intent in ["ViewTrendOverTime", "AskAttendance"]
    is_admin_or_head(user_role)
}
rationale_code := "ADMIN_TREND_ACCESS_ALLOWED" if {
    input.intent in ["ViewTrendOverTime", "AskAttendance"]
    is_admin_or_head(user_role)
}

# SH-5: Developer inspects system reasoning
decision := "PROCEED_WITH_CONDITIONS" if {
    input.intent == "InspectSystemReasoning"
    user_role == "developer"
}
conditions := ["no_private_student_data"] if {
    input.intent == "InspectSystemReasoning"
    user_role == "developer"
}
rationale_code := "DEVELOPER_TRACE_INSPECTION_ALLOWED" if {
    input.intent == "InspectSystemReasoning"
    user_role == "developer"
}

# ── GRIEVANCE DOMAIN ──────────────────────────────────────────────────────

# G-1: Any authenticated user can file a grievance
decision := "PROCEED" if {
    input.intent == "FileGrievance"
    user_role in ["parent", "teacher", "admin", "principal", "medical_admin", "school_admin", "student"]
}
rationale_code := "GRIEVANCE_FILING_ALLOWED" if {
    input.intent == "FileGrievance"
}

# G-2: Any authenticated user can check grievance policy/procedure
decision := "PROCEED" if {
    input.intent == "GrievancePolicy"
    user_role != "guest"
}
rationale_code := "GRIEVANCE_POLICY_ALLOWED" if {
    input.intent == "GrievancePolicy"
}

# G-3: User can view status of their own grievance
decision := "PROCEED_WITH_CONDITIONS" if {
    input.intent == "ViewGrievanceStatus"
    user_role != "guest"
}
conditions := ["own_grievance_only"] if {
    input.intent == "ViewGrievanceStatus"
    user_role != "guest"
}
rationale_code := "GRIEVANCE_STATUS_ALLOWED" if {
    input.intent == "ViewGrievanceStatus"
}

# ── GENERAL & TUTOR DOMAIN ────────────────────────────────────────────────

# General Query — open to all
decision := "PROCEED" if {
    input.intent == "general_query"
}
rationale_code := "GENERAL_QUERY_ALLOWED" if {
    input.intent == "general_query"
}

decision := "PROCEED" if {
    input.intent == "ExplainConcept"
}

decision := "PROCEED_WITH_CONDITIONS" if {
    input.intent == "ExplainSolutionStepByStep"
}
conditions := ["instructional_only"] if {
    input.intent == "ExplainSolutionStepByStep"
}

# Parent views learning trend over time
decision := "PROCEED_WITH_CONDITIONS" if {
    input.intent == "ViewLearningTrendOverTime"
    user_role == "parent"
    is_target_child
    parent_has_child(actor_id, target_actor_id)
}
conditions := ["own_child_only", "descriptive_only"] if {
    input.intent == "ViewLearningTrendOverTime"
    user_role == "parent"
    is_target_child
    parent_has_child(actor_id, target_actor_id)
}

# Teacher assigns or reviews exercises
decision := "PROCEED" if {
    input.intent == "AssignAndReviewExercise"
    user_role in ["teacher", "tutor"]
}

# Admin compares cohort performance
decision := "PROCEED" if {
    input.intent == "CompareCohortPerformance"
    is_admin_or_head(user_role)
}
