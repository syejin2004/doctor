const express = require('express');
const cors = require('cors');
require('dotenv').config();
// [수정 1] SchemaType 제거 (오류 원인)
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const port = 3000;
app.use(cors());
app.use(express.json());

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);

const formatDataForPrompt = (qData) => {
    if (!qData) return "환자 데이터가 없습니다.";
    
    const joinArr = (arr) => (arr && arr.length > 0) ? arr.join(', ') : '특이사항 없음';

    // 카테고리별 상세 데이터 정리
    let specificInfo = "";
    let categoryName = "";

    switch(qData.category) {
        case 'pregnancy':
            categoryName = "임신 확인 및 산전 관리 (Obstetrics)";
            specificInfo = `
            - UPT(임신테스트기): ${qData.preg_test_result}
            - GA(추정주수): ${qData.preg_weeks}
            - SX(주증상): ${joinArr(qData.preg_symptoms)}
            - PHx(산과력 특이사항): ${qData.preg_history_detail}
            - Meds(약물): ${qData.preg_meds}`;
            break;
        case 'preparation':
            categoryName = "난임 및 임신 준비 (Infertility)";
            specificInfo = `
            - Duration(시도기간): ${qData.prep_duration}
            - Cycle(주기): ${qData.prep_cycle_detail}
            - Method(확인방법): ${joinArr(qData.prep_method)}
            - Gyn Hx(부인과력): ${joinArr(qData.prep_history)}
            - Partner Hx(배우자검사): ${qData.prep_partner}`;
            break;
        case 'period':
            categoryName = "월경 이상 (Menstrual Disorders)";
            specificInfo = `
            - C.C(주호소): ${joinArr(qData.period_symptom)}
            - NRS(통증점수): ${qData.period_pain_score}
            - Amount(월경량): ${qData.period_amount}
            - Social Hx(생활변화): ${qData.period_change}
            - Family Hx(가족력): ${qData.period_family}`;
            break;
        case 'problem':
            categoryName = "질염/골반통 (Gynecology)";
            specificInfo = `
            - Discharge(분비물 양상): ${joinArr(qData.prob_discharge_color)}
            - Pain/Sensation(통증/불편감): ${joinArr(qData.prob_sensation)}
            - Onset(기간): ${qData.prob_duration}
            - Recurrence(재발여부): ${qData.prob_recurrence}
            - Sexual Hx(파트너): ${qData.prob_partner}`;
            break;
        case 'contraception':
            categoryName = "피임 상담 (Contraception)";
            specificInfo = `
            - Current Method(현재방법): ${qData.contra_current}
            - Needs(희망상담): ${joinArr(qData.contra_wish)}
            - Smoking(흡연): ${qData.contra_smoking}
            - Risk Factors(위험인자): ${qData.contra_risk}
            - Family Plan(향후계획): ${qData.contra_plan}`;
            break;
        default:
            categoryName = "일반 진료";
    }

    return `
    [Patient Assessment Data]
    - Chief Complaint Category: ${categoryName}
    - LMP (Last Menstrual Period): ${qData.common_lmp || 'Unknown'}
    - Obstetric History (G-P-A): ${qData.common_gpa || 'Not checked'}
    - Past Medical History: ${qData.common_history || 'None'}
    - Patient Goals/Questions: ${qData.common_goals || 'None'}
    
    [Specific Details]
    ${specificInfo}
    `;
};

// [수정 2] SchemaType을 문자열로 정의하여 호환성 확보
const responseSchema = {
    type: "OBJECT",
    properties: {
        summary: { type: "STRING" },
        sentiment: { type: "STRING" },
        keywords: { type: "ARRAY", items: { type: "STRING" } },
        doctor_questions: { type: "ARRAY", items: { type: "STRING" } },
        chart_data: {
            type: "OBJECT",
            properties: {
                pain: { type: "NUMBER" },
                bleeding: { type: "NUMBER" },
                urgency: { type: "NUMBER" },
                stress: { type: "NUMBER" },
                severity: { type: "NUMBER" }
            },
            required: ["pain", "bleeding", "urgency", "stress", "severity"]
        }
    },
    required: ["summary", "sentiment", "keywords", "doctor_questions", "chart_data"]
};

app.post('/summarize', async (req, res) => {
    try {
        const questionnaireData = req.body.questionnaireData;
        const userPrompt = formatDataForPrompt(questionnaireData);
        
        // [핵심 수정] 산부인과 전문의 페르소나 프롬프트 강화
        const systemPrompt = `
        당신은 대학병원 산부인과 전문의(Attending Physician)입니다. 
        환자의 사전 문진표(Pre-consultation Questionnaire)를 분석하여, 담당 의사가 진료 전 EMR(전자의무기록)에 참고할 수 있는 '임상 요약(Clinical Summary)'을 작성하십시오.

        [지침 사항]
        1. **Summary (임상 요약)**: 
           - 의학적 전문 용어(Medical Terminology)와 약어를 적절히 사용하여 SOAP Note 형식의 Subjective 섹션처럼 작성하십시오.
           - 환자의 주호소(C.C), 현병력(PI), LMP, 산과력(G/P)을 반드시 포함하십시오.
           - 예시: "28세 여성, LMP 2024-01-01. C.C: Dysmenorrhea 및 Menorrhagia 호소. NRS 7점의 하복부 통증이 있으며 진통제로 조절되지 않음."

        2. **Sentiment (상태 태그)**: 
           - 환자의 상태를 한눈에 파악할 수 있는 임상적 태그 1개 (4글자 내외).
           - 예: #R/O_PCOS, #임신초기, #PID의심, #응급수술, #정기검진

        3. **Keywords (핵심 키워드)**: 
           - 진단 및 처방에 결정적인 의학적 키워드 5개. (영어/한글 병기 가능)
           - 예: ["Amenorrhea", "LMP 불명확", "PCOS Hx", "Pregnancy Test (+)", "Spotting"]

        4. **Doctor Questions (심층 추가 문진)**: 
           - 감별 진단(Differential Diagnosis)을 위해 의사가 진료실에서 반드시 물어봐야 할 날카로운 질문 3~5개를 작성하십시오.
           - 일반적인 질문보다는 의학적 근거를 파악하기 위한 질문이어야 합니다.
           - 예: "생리량이 가장 많을 때 대형 패드를 몇 시간에 한 번 교체하시나요?", "성관계 후 출혈(Postcoital bleeding)이 있었나요?", "발열이나 오한 등 전신 증상이 동반되나요?"

        5. **Chart Data (증상 정량화)**: 
           - 텍스트 데이터를 근거로 0~10점 척도로 수치화하십시오. (추정치)
           - pain: 통증 강도 (NRS 기반, 언급 없으면 0)
           - bleeding: 출혈 및 분비물의 양 (단순 분비물 2~3, 과다월경/하혈 7~10)
           - urgency: 진료의 긴급도 (응급피임약/복통/하혈 시 높음)
           - stress: 심리적 불안감 및 스트레스 수준
           - severity: 종합적인 임상적 심각도
        `;

        const model = genAI.getGenerativeModel({ 
            model: "gemini-2.5-flash-preview-09-2025", 
            systemInstruction: systemPrompt,
            generationConfig: {
                responseMimeType: "application/json",
                responseSchema: responseSchema,
            },
        });
        
        const result = await model.generateContent(userPrompt);
        const aiJson = JSON.parse(result.response.text());

        res.json(aiJson);

    } catch (error) {
        console.error("AI Error:", error);
        res.status(500).json({ error: "AI 분석 실패" });
    }
});

app.listen(port, () => {
    console.log(`OB/GYN AI Server running on http://localhost:${port}`);
});