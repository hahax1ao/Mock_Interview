export type EnglishQuestionCategory =
  | "personal"
  | "campus_life"
  | "qualities"
  | "learning"
  | "experience"
  | "motivation"
  | "postgraduate_awareness"
  | "future"
  | "pressure";

export type EnglishQuestion = {
  id: string;
  text: string;
  category: EnglishQuestionCategory;
};

export const englishQuestionBank: readonly EnglishQuestion[] = [
  { id: "english-hometown", text: "Introduce your hometown briefly.", category: "personal" },
  {
    id: "english-university",
    text: "Could you tell us something about your university?",
    category: "campus_life",
  },
  { id: "english-advantages", text: "Introduce your advantages.", category: "qualities" },
  { id: "english-disadvantages", text: "Introduce your disadvantages.", category: "qualities" },
  {
    id: "english-spare-time",
    text: "How do you spend your spare time?",
    category: "campus_life",
  },
  {
    id: "english-personality",
    text: "What kind of person do you think you are?",
    category: "qualities",
  },
  {
    id: "english-learning-methods",
    text: "Talk about your learning methods and how you learn English.",
    category: "learning",
  },
  {
    id: "english-research-advantages",
    text: "What personal qualities would help you in future academic research?",
    category: "qualities",
  },
  {
    id: "english-team-role",
    text: "What role do you usually play in a team?",
    category: "qualities",
  },
  {
    id: "english-proud-experience",
    text: "What experience are you most proud of?",
    category: "experience",
  },
  {
    id: "english-postgraduate-study",
    text: "Why do you choose to pursue postgraduate study?",
    category: "motivation",
  },
  {
    id: "english-unforgettable-experience",
    text: "What is your most unforgettable experience?",
    category: "experience",
  },
  {
    id: "english-unforgettable-person",
    text: "Who is the most unforgettable person in your life?",
    category: "experience",
  },
  {
    id: "english-social-activities",
    text: "Have you joined any social activities? Please briefly introduce one experience.",
    category: "experience",
  },
  {
    id: "english-academic-misconduct",
    text: "What do you think of academic misconduct?",
    category: "postgraduate_awareness",
  },
  {
    id: "english-undergraduate-postgraduate",
    text: "What is the difference between undergraduate and postgraduate study?",
    category: "postgraduate_awareness",
  },
  {
    id: "english-choose-university",
    text: "Why do you choose our university?",
    category: "motivation",
  },
  {
    id: "english-choose-major",
    text: "Why do you choose this postgraduate field?",
    category: "motivation",
  },
  {
    id: "english-choose-direction",
    text: "Why do you choose this research direction or supervisor?",
    category: "motivation",
  },
  {
    id: "english-study-plan",
    text: "What are your plans for postgraduate study?",
    category: "future",
  },
  {
    id: "english-quality-postgraduate",
    text: "What is the most important quality for a postgraduate student?",
    category: "postgraduate_awareness",
  },
  {
    id: "english-research-interests",
    text: "What broad areas are you interested in exploring during postgraduate study?",
    category: "future",
  },
  {
    id: "english-phd",
    text: "Do you intend to pursue a PhD in the future?",
    category: "future",
  },
  {
    id: "english-not-admitted",
    text: "What will you do if you are not admitted?",
    category: "pressure",
  },
  {
    id: "english-choose-you",
    text: "Why should we choose you among many candidates?",
    category: "pressure",
  },
  {
    id: "english-failure",
    text: "Please share a past failure and what you learned from it.",
    category: "experience",
  },
  { id: "english-pressure", text: "How do you face pressure?", category: "pressure" },
] as const;

const forbiddenPatterns = [
  /\b(major|courses?|favorite subject|skills?)\b/i,
  /\b(paper|thesis|publication)\b/i,
  /\b(project|competition entry|algorithm|technical details?|circuit|protocol)\b/i,
  /专业课程|专业技能|论文|项目|竞赛|算法|技术细节/,
];

export function isForbiddenEnglishQuestion(text: string) {
  return forbiddenPatterns.some((pattern) => pattern.test(text));
}

export function isValidEnglishQuestion(text: string) {
  const questionMarkCount = text.match(/[?？]/g)?.length ?? 0;
  return text.trim().length > 0 && questionMarkCount === 1 && !isForbiddenEnglishQuestion(text);
}

export function selectEnglishQuestion(
  usedIds: string[],
  usedCategories: EnglishQuestionCategory[],
) {
  const unused = englishQuestionBank.filter((question) => !usedIds.includes(question.id));
  const differentCategory = unused.find(
    (question) => !usedCategories.includes(question.category),
  );
  return differentCategory ?? unused[0] ?? englishQuestionBank[0];
}
