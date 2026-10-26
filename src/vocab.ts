// Terms the speech recogniser should favour. Edit freely for other courses.
export const VOCABULARY = [
  'Itô', 'Ito', "Itô's lemma", 'Itô integral', 'Itô isometry', 'Stratonovich',
  'Brownian motion', 'Wiener process', 'martingale', 'local martingale', 'semimartingale', 'submartingale',
  'filtration', 'adapted', 'progressively measurable', 'stopping time', 'quadratic variation', 'covariation',
  'drift', 'diffusion', 'diffusion coefficient', 'Girsanov', 'Radon–Nikodym', 'Novikov', 'Feynman–Kac',
  'Fokker–Planck', 'Kolmogorov', 'generator', 'Markov', 'strong solution', 'weak solution',
  'Lipschitz', 'Gronwall', 'Ornstein–Uhlenbeck', 'geometric Brownian motion', 'Lévy', 'Doob',
  'Burkholder–Davis–Gundy', 'sigma algebra', 'measurable', 'almost surely', 'in probability', 'L2',
  'Euler–Maruyama', 'Milstein', 'Black–Scholes', 'stochastic integral', 'Riemann–Stieltjes',
];

// Korean lectures still use plenty of English terms; give the Korean recogniser both.
export const VOCABULARY_KO = [
  '확률미분방정식', '브라운 운동', '위너 과정', '마팅게일', '국소 마팅게일', '이토 적분', '이토 공식', '이토 보조정리',
  '스트라토노비치', '이차 변동', '필트레이션', '여과', '정지 시간', '적합 과정', '표류', '확산', '확산 계수',
  '거사노프', '라돈 니코딤', '파인만 카츠', '포커 플랑크', '콜모고로프', '생성자', '마르코프', '강해', '약해',
  '립시츠', '그론월', '오른스타인 울렌벡', '기하 브라운 운동', '거의 확실하게', '확률 수렴', '시그마 대수', '가측',
  ...VOCABULARY.slice(0, 30),
];
