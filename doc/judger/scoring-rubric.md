# Scoring rubric for 1v1 human–AI debates

Status: design draft for judging future structured debate sessions. Current Arena comparisons use the [shared provisional speech criteria](README.md#arena-speech-comparison) to score four independent opening speeches.

This rubric applies to one-on-one debates between a human and an AI, adapted from British Parliamentary (BP) rules. Government and Opposition each speak three times: a constructive speech, an extension speech and a summary speech. It is intended for the judge model and for human adjudicators and debaters.

This rubric scores how well each side debates. It is separate from the style assessments in `data/<record>/judger-score.md`, which classify how a speaker talks without measuring debate quality.

---

## 1. Judging principles

- **Ordinary intelligent voter.** Judge persuasiveness from the viewpoint of an ordinary, well-informed voter. No specialist knowledge is assumed, and jargon or bravado earns nothing by itself.
- **Judge only what was said.** Score only what the speakers actually said. The judge must not use their own knowledge to complete an argument or rebuttal for either side.
- **Style neutrality.** Do not add or deduct marks for persona style itself. A humorous speaker is not penalised for humour, and a serious speaker is not penalised for seriousness.
- **Length neutrality.** Speech length is not a merit in itself.
- **Anonymous judging.** The judge sees only "Government" and "Opposition" and is not told which side is the AI.
- **Tolerance for spoken language.** Filler words and repetitions are removed from the human's transcript before judging. Do not deduct marks for disfluency, and do not add or deduct marks for accent, pace or text-to-speech voice.

---

## 2. Dimensions and weights

| Dimension | Weight | Core question |
|---|---|---|
| Analysis | 30% | Do the arguments stand up? Why are they true, and why do they matter? |
| Engagement and weighing | 25% | Did the speaker engage with the opposing case, anticipating it in the first speech and answering it thereafter? Did they show why their side matters more? |
| Role fulfilment | 20% | Did the speech perform its duties in the format? |
| Delivery and persuasion | 15% | Can the audience follow easily, and are they persuaded? |
| Examples | 10% | Are examples specific, credible and genuinely supportive of the argument? |

Each speech is scored from 1 to 5 on all five dimensions. Examples are not scored for summary speeches and are recorded as N/A.

---

## 3. Level descriptors

### 3.1 Analysis (30%)

A complete argument has three parts: a **claim** (what I believe), a **mechanism** (why it happens, with every step of the causal chain) and an **impact** (who is affected, how much, and why it matters).

| Score | Descriptor |
|---|---|
| 5 | Every argument has a clear claim, a complete mechanism and a specific impact. The causal chain has no gaps. The most obvious rebuttals are pre-empted. |
| 4 | Claim and mechanism are complete; the impact is slightly underdeveloped, or there is one gap in reasoning. |
| 3 | The claim is clear, but the mechanism relies mainly on assertion ("this will obviously lead to…") and the impact stays general. |
| 2 | Arguments overlap or contradict each other; most mechanisms are missing. |
| 1 | Conclusions without reasoning, or arguments unrelated to the motion. |

**What to look for:** whether each argument explains why it is true and why it matters, and whether several "arguments" are the same argument reworded.

### 3.2 Engagement and weighing (25%)

**Weighing** means explicitly comparing the importance of each side's arguments. Common criteria are scale (how many people are affected), probability (how likely it is to happen), urgency (how soon), reversibility (whether harm can be undone) and the vulnerability of the people affected.

Government constructive is the first speech, before Opposition has presented its case. Use the opening-specific descriptors below to assess how the speech anticipates a reasonable opposing case and weighs the alternatives. Score only anticipation and comparisons actually present in the speech; do not invent objections for the speaker or judge the opening against arguments raised later. A speech can earn 5 without receiving a POI. All later speeches use the response-based descriptors.

| Score | Government constructive | All later speeches |
|---|---|---|
| 5 | Addresses the strongest reasonable objection to its case with a specific answer. Uses weighing criteria explicitly to show why its side matters more than the alternative. | Answers the opponent's strongest argument and identifies a specific flaw. No key opposing argument is left unanswered. Uses weighing criteria explicitly to show why their side matters more. |
| 4 | Addresses relevant anticipated objections; weighing is present but not explicit enough. | Answers most key arguments; weighing is present but not explicit enough. |
| 3 | Addresses only a secondary anticipated objection, or asserts its own case without developing the comparison. Little or no weighing. | Responds, but to secondary arguments, or repeats their own case instead of rebutting. Little or no weighing. |
| 2 | Dismisses the opposing case superficially, without a substantive answer or comparison. | Superficial responses ("my opponent is wrong"); key arguments are left unanswered. |
| 1 | Does not address an opposing case or compare alternatives. | Ignores the opponent entirely. |

**Recording rules:**

- A key argument that the opponent never answers is treated as conceded by the opponent.
- Before Opposition has spoken, there are no unanswered opposing arguments to record; anticipated objections are not concessions by Opposition.
- Points of Information (POIs) count towards this dimension. Offering a POI that exposes a real weakness is evidence for a higher score. Answering a POI directly and effectively is evidence for a higher score; dodging it is evidence for a lower one.
- A speaker who was offered POIs but accepted none loses 1 mark on this dimension (minimum 1).

### 3.3 Role fulfilment (20%)

Each speech has different duties. Check them against this list:

| Speech | Duties |
|---|---|
| Government constructive | Gives a clear, reasonable definition; presents a concrete model (who acts, what they do, how it is implemented); presents two arguments. |
| Opposition constructive | Responds to the definition (accepts it, or challenges it with reasons); rebuts Government's central argument; establishes the Opposition's line and presents two arguments. |
| Extension | Rebuts the opponent's strongest argument first; rebuilds their own case; presents at least one new argument that has not appeared before and adds substance. |
| Summary | Introduces no new arguments; identifies two or three central clashes; uses weighing to show why their side wins those clashes. |

| Score | Descriptor |
|---|---|
| 5 | All duties completed well, for example a definition so clear the opponent cannot fault it. |
| 4 | All duties completed, with some rough handling. |
| 3 | One minor duty missing, for example a Government constructive with only one argument. |
| 2 | One core duty missing, for example an extension speech with no new argument. |
| 1 | Serious breach of role, for example a summary consisting mainly of new arguments, or a Government definition that reduces the motion to a truism. |

### 3.4 Delivery and persuasion (15%)

Judge from the cleaned transcript only, not from the sound of the voice. The AI's voice is produced by text-to-speech and does not reflect the debater's ability.

| Score | Descriptor |
|---|---|
| 5 | Structure is easy to follow by ear, with signposting such as "first" and "second". Language is concrete and vivid, tone fits the argument, and there are memorable lines. |
| 4 | Clear and easy to follow, with occasional wordiness or abstraction. |
| 3 | Understandable, but loosely structured; listeners have to organise it themselves. |
| 2 | Disorganised and repetitive; listeners struggle to follow. |
| 1 | Listeners cannot understand the main arguments. |

### 3.5 Examples (10%)

Speakers cannot research outside the preparation phase, so this dimension rewards specific, well-fitted examples rather than the number of citations. An example clearly presented as hypothetical ("Picture a nurse in Leeds working a double shift…") is not fabrication and can score normally.

| Score | Descriptor |
|---|---|
| 5 | Examples are specific (with a time, place or person), credible, and genuinely support the argument's mechanism. |
| 4 | Examples are specific and closely relevant. |
| 3 | Examples are vague ("many countries do this") or decorative, without supporting the mechanism. |
| 2 | Examples are weakly connected to the argument, or contain clear factual errors. |
| 1 | No examples, or fabricated data, studies or quotations. |

---

## 4. Violations

| Violation | Consequence |
|---|---|
| Fabricated data, studies or quotations | Examples scored 1; arguments relying on that evidence are disregarded in the decision. |
| Personal attacks | Delivery and persuasion scored 1. |
| Extension speech with no new argument | Role fulfilment capped at 2. |
| New arguments in a summary speech | Role fulfilment capped at 2; the new arguments are disregarded in the decision. |
| Unreasonable Government definition, or an Opposition challenge without reasons | Role fulfilment capped at 2. |
| Exceeding the 15-second grace period | The speech is cut off; anything after the cut is not judged. |
| Offered POIs but accepted none | Engagement and weighing reduced by 1. |

---

## 5. Scoring and decision

### 5.1 Speaker points

1. For each dimension, average the side's scores across its three speeches (for examples, use only the first two speeches). Include Government constructive's numeric engagement score using its opening-specific descriptors; the engagement weight remains 25% for both sides.
2. Apply the weights to get a weighted average from 1 to 5.
3. Convert to speaker points: **speaker points = 50 + (weighted average − 1) × 12.5**, giving a range of 50 to 100.

| Speaker points | Level |
|---|---|
| 90–100 | Outstanding; arguments and engagement are close to flawless. |
| 80–89 | Excellent; complete arguments and strong engagement. |
| 70–79 | Competent to good; main arguments stand, with clear room for improvement. |
| 60–69 | Weak; major flaws in argument or engagement. |
| 50–59 | Very weak; duties largely unfulfilled. |

### 5.2 Decision

In BP the result is a holistic judgement, not a mechanical sum. Decide in this order:

1. Identify the two or three clashes that decide the debate.
2. Decide who won each clash and give reasons.
3. The side that wins the more important clashes wins the debate.
4. **No low-point wins.** The winner's speaker points must be higher than the loser's. If the weighted calculation conflicts with the decision, re-examine the dimension scores and explain any adjustment.

---

## 6. Judging procedure

1. **After each speech:** write the reasoning first, then score the five dimensions, citing a quoted sentence from the speech as evidence for each score. Record the opponent's unanswered arguments.
2. **After the debate:** calculate dimension averages and speaker points, identify the deciding clashes, decide the result and check for a low-point win.
3. **Write the verdict:** explain the result to the audience in one sentence.
4. **Reduce bias:** use temperature 0. Do not add or deduct marks for length, style or disfluency. Optionally judge a second time with the sides presented in reverse order; if the two results differ, use the one with the more thorough clash analysis.

---

## 7. Output format

After each speech:

```json
{
  "speech": "Government constructive",
  "reasoning": "Reasoning written before the scores",
  "scores": {"analysis": 4, "engagement": 3, "role": 5, "delivery": 4, "examples": 3},
  "evidence_quotes": {"analysis": "Quoted sentence from the speech as evidence"},
  "violations": [],
  "unanswered_points": []
}
```

After the debate:

```json
{
  "clashes": [
    {"issue": "Clash", "winner": "Government", "why": "Reason for the win"}
  ],
  "winner": "Opposition",
  "speaker_points": {"Government": 72, "Opposition": 78},
  "verdict": "One-sentence verdict for the audience"
}
```
