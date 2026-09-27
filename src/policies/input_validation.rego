package conversalx.input

# ConvAI MVP — Input Validation Policies
# Detects harmful requests, property damage threats, and manipulation.

import future.keywords.if
import future.keywords.in

default allow := true
default reason := "Input permitted"

# ── Safety Rules ───────────────────────────────────────────────────

# Deny if input contains keywords related to harm to life
deny_harm_to_life if {
    some word in ["hurt", "kill", "die", "suicide", "bomb", "poison", "murder", "stab", "shoot"]
    contains(lower(input.text), word)
}

# Deny if input contains keywords related to property damage/theft
deny_property_damage if {
    some word in ["steal", "rob", "sabotage", "burn down", "vandalize", "hack into", "leak"]
    contains(lower(input.text), word)
}

# Deny if input contains manipulation or jailbreak attempts
deny_manipulation if {
    some word in ["ignore previous instructions", "forget all instructions", "system prompt", "as a developer", "jailbreak"]
    contains(lower(input.text), word)
}

# ── Final Decision ─────────────────────────────────────────────────

# Main decision logic
decision := "DENY" if {
    deny_harm_to_life
} else := "DENY" if {
    deny_property_damage
} else := "DENY" if {
    deny_manipulation
} else := "ALLOW"

# Reason logic
reason := "Harm to life policy violation" if deny_harm_to_life
else := "Property damage policy violation" if deny_property_damage
else := "System manipulation attempt detected" if deny_manipulation
else := "Input permitted"
