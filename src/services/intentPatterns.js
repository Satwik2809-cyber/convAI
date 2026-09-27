/**
 * ConvAI MVP — Intent Classification Patterns
 * 
 * Configurable keyword-to-intent mapping per industry.
 * This serves as the deterministic (rule-based) layer of intent classification.
 * Easy to extend without code changes — just add entries to the maps.
 */

const educationIntents = {
  ask_grades: {
    keywords: ['grade', 'grades', 'marks', 'score', 'scores', 'report card', 'result', 'results', 'gpa', 'cgpa', 'percentage'],
    priority: 1,
  },
  ask_schedule: {
    keywords: ['schedule', 'timetable', 'time table', 'class timing', 'class time', 'when is', 'calendar', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
    priority: 1,
  },
  ask_curriculum: {
    keywords: ['curriculum', 'syllabus', 'course content', 'subjects', 'what is taught', 'course outline', 'lesson plan', 'course material'],
    priority: 1,
  },
  ask_admission: {
    keywords: ['admission', 'admissions', 'enroll', 'enrollment', 'registration', 'apply', 'application', 'join', 'entry', 'requirement', 'eligibility'],
    priority: 1,
  },
  ask_fees: {
    keywords: ['fee', 'fees', 'tuition', 'payment', 'cost', 'price', 'scholarship', 'financial aid', 'installment', 'billing'],
    priority: 1,
  },
  ask_teacher_info: {
    keywords: ['teacher', 'teachers', 'professor', 'instructor', 'faculty', 'staff', 'who teaches', 'teaching'],
    priority: 2,
  },
  ask_attendance: {
    keywords: ['attendance', 'absent', 'absence', 'present', 'leave', 'sick leave'],
    priority: 2,
  },
  general_query: {
    keywords: [],
    priority: 99, // Catch-all
  },
};

};

module.exports = {
  education: educationIntents,
};
