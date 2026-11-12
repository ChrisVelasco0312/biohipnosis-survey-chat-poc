export const SURVEY_VERSION = 'poc-1.0';

export const SECTIONS = [
  {
    id: 'A',
    name: 'Datos personales',
    short: 'Datos',
    intro: 'Empecemos por tus datos personales. Son 10 preguntas breves y puedes responder a tu ritmo.',
  },
  {
    id: 'B',
    name: 'Motivo de la consulta',
    short: 'Motivo',
    intro: 'Ahora hablemos del motivo de tu consulta.',
  },
  {
    id: 'C',
    name: 'Objetivo',
    short: 'Objetivo',
    intro: 'Sigamos con lo que buscas y con lo que te mueve.',
  },
  {
    id: 'D',
    name: 'Origen e infancia',
    short: 'Origen',
    intro:
      'Pasemos a tu origen y tu infancia. Responde a tu ritmo. Puedes decir “no sé” o “prefiero no responder” sin problema.',
  },
  {
    id: 'E',
    name: 'Familia',
    short: 'Familia',
    intro: 'Ahora exploraremos tu familia y las relaciones que la han marcado.',
  },
  {
    id: 'F',
    name: 'Árbol familiar',
    short: 'Árbol',
    intro:
      'Vamos a armar tu árbol familiar por partes. Puedes decir “no tengo información” en cualquier momento.',
  },
  {
    id: 'G',
    name: 'Sucesos significativos',
    short: 'Sucesos',
    intro: 'Para cerrar la historia, hablemos de los sucesos significativos de tu vida.',
  },
  {
    id: 'H',
    name: 'Cierre',
    short: 'Cierre',
    intro: 'Ya casi terminamos. Voy a mostrarte un resumen para que lo confirmes o lo corrijas.',
  },
];

const sub = (key, label, keywords = [], optional = false) => ({ key, label, keywords, optional });

export const ITEMS = [
  // A. Datos personales (10)
  {
    id: 'D01',
    sectionId: 'A',
    label: 'Datos iniciales',
    prompt: 'Para comenzar, ¿cuál es tu nombre completo, tu edad y tu fecha y lugar de nacimiento?',
    type: 'text',
    format: 'personal_data',
    critical: true,
    clarify: 'Para completar: ¿tu nombre completo, tu edad, y tu fecha y lugar de nacimiento?',
    example: 'Por ejemplo: “Me llamo Ana María Restrepo, tengo 34 años y nací el 3 de diciembre de 1994 en Popayán, Cauca, Colombia”.',
    subfields: [
      sub('nombre_completo', 'nombre completo', ['nombre', 'llamo', 'apellido']),
      sub('edad', 'edad en años', ['años', 'edad', 'tengo']),
      sub('fecha_nacimiento', 'fecha de nacimiento', ['nací', 'nacimiento', 'fecha']),
      sub('lugar_nacimiento', 'lugar de nacimiento', ['lugar', 'ciudad', 'municipio', 'nací en']),
    ],
  },
  {
    id: 'D06',
    sectionId: 'A',
    label: 'Estado civil',
    prompt: '¿Cuál es tu estado civil?',
    type: 'option',
    format: 'option',
    options: ['soltero/a', 'casado/a', 'unión libre', 'separado/a', 'divorciado/a', 'viudo/a'],
    clarify: '¿Me dices cuál de esas opciones te describe?',
    subfields: [sub('estado_civil', 'estado civil', ['solter', 'casad', 'unión', 'union', 'separ', 'divorci', 'viud'])],
  },
  {
    id: 'D07',
    sectionId: 'A',
    label: 'Hijos',
    prompt: '¿Tienes hijos? Si es así, cuéntame cuántos y sus edades. Si no, escribe “no tengo”.',
    type: 'list',
    format: 'children',
    clarify: '¿Me lo compartes de nuevo?',
    example: 'Por ejemplo: “Tengo 2 hijos, de 8 y 12 años” o “No tengo”.',
    subfields: [sub('cantidad', 'cantidad de hijos', ['hijo', 'hija', 'tengo']), sub('edades', 'edades', ['años', 'edad'])],
  },
  {
    id: 'D08',
    sectionId: 'A',
    label: 'Actividad actual',
    prompt: '¿A qué te dedicas actualmente?',
    type: 'text',
    clarify: '¿Me cuentas a qué te dedicas hoy: trabajo, estudio, hogar, jubilación u otra actividad?',
    subfields: [sub('actividad', 'actividad actual', ['trabajo', 'estudio', 'dedico', 'hogar', 'jubil'])],
  },
  {
    id: 'D09',
    sectionId: 'A',
    label: 'Estudios',
    prompt: '¿Qué estudios realizaste o estás realizando?',
    type: 'text',
    clarify: '¿Qué nivel de estudios tienes y en qué área?',
    subfields: [sub('estudios', 'estudios', ['primaria', 'secundaria', 'técnico', 'tecnico', 'univers', 'posgrado', 'estudi'])],
  },
  {
    id: 'D10',
    sectionId: 'A',
    label: 'Enfermedades en la infancia',
    prompt: '¿Tuviste enfermedades importantes en la infancia?',
    type: 'narrative',
    clarify: '¿Recuerdas alguna enfermedad de tu infancia, aunque fuera leve? Si no, dime “ninguna”.',
    subfields: [sub('enfermedades', 'enfermedades de la infancia', ['enferm', 'fiebre', 'varicela', 'asma', 'ninguna', 'ningun'])],
  },
  {
    id: 'D11',
    sectionId: 'A',
    label: 'Cirugías',
    prompt: '¿Te han practicado cirugías? Cuéntame cuáles y a qué edad, si las recuerdas.',
    type: 'narrative',
    clarify: '¿Qué cirugías has tenido y a qué edad? Si no has tenido, escribe “ninguna”.',
    subfields: [sub('cirugias', 'cirugías', ['cirug', 'operac', 'ninguna', 'ningun'])],
  },
  {
    id: 'D12',
    sectionId: 'A',
    label: 'Accidentes',
    prompt: '¿Has tenido accidentes relevantes?',
    type: 'narrative',
    clarify: '¿Qué accidentes recuerdas y a qué edad ocurrieron? Si no, dime “ninguno”.',
    subfields: [sub('accidentes', 'accidentes', ['accident', 'golpe', 'caída', 'caida', 'ninguno', 'ningun'])],
  },
  {
    id: 'D13',
    sectionId: 'A',
    label: 'Hobbies',
    prompt: '¿Qué te gusta hacer en tu tiempo libre?',
    type: 'text',
    clarify: '¿Qué actividades disfrutas en tu tiempo libre?',
    subfields: [sub('hobbies', 'pasatiempos', ['gusta', 'tiempo libre', 'hobby', 'afición', 'aficion'])],
  },
  {
    id: 'D14',
    sectionId: 'A',
    label: 'Mano dominante',
    prompt: '¿Eres diestro(a) o zurdo(a)?',
    type: 'option',
    format: 'handedness',
    clarify: 'Responde “diestro”, “zurdo” o “ambidiestro”.',
    subfields: [sub('mano_dominante', 'mano dominante', ['diestro', 'zurdo', 'derecha', 'izquierda', 'ambidiestro'])],
  },

  // B. Motivo de la consulta (3)
  {
    id: 'M01',
    sectionId: 'B',
    label: 'Motivo principal',
    prompt:
      '¿Cuál es el motivo principal de tu consulta? Descríbelo en tus propias palabras y con un poco de detalle, como si se lo explicaras a alguien que no conoce el tema.',
    type: 'narrative',
    clarify: '¿Cuál es el motivo más importante de tu consulta y cómo lo describirías con tus palabras?',
    subfields: [sub('motivo', 'motivo principal', ['consulta', 'motivo', 'porque', 'siento', 'problema'])],
  },
  {
    id: 'M02',
    sectionId: 'B',
    label: 'Diagnóstico profesional',
    prompt:
      '¿Existe un diagnóstico emitido por algún profesional de la salud y deseas compartirlo? No necesitas enviar archivos: puedes responder “sí” o “no” y, si quieres, contarlo con tus palabras.',
    type: 'short',
    format: 'diagnosis_gate',
    clarify: '¿Un profesional de la salud te ha emitido un diagnóstico? Responde “sí, deseo compartirlo” o “no”.',
    example: 'Por ejemplo: “Sí, me diagnosticaron ansiedad” o “No, no existe diagnóstico”.',
    subfields: [
      sub('diagnostico_profesional', 'diagnóstico profesional', [
        'diagnóstico',
        'diagnostico',
        'profesional',
        'médic',
        'medic',
        'psicólog',
        'psicolog',
        'psiquiatra',
        'compartir',
        'existe',
        'no',
      ]),
    ],
  },
  {
    id: 'M04',
    sectionId: 'B',
    label: 'Diagnóstico y fecha',
    prompt:
      '¿Cuál fue el diagnóstico y cuándo lo recibiste? Si hay varios, indica el diagnóstico, la fecha y tu edad para cada uno.',
    type: 'date_text',
    format: 'date_text',
    clarify: '¿Me das el diagnóstico, la fecha o el año en que lo recibiste y la edad que tenías? Si no lo sabes, dime “no sé”.',
    example: 'Por ejemplo: “Me diagnosticaron ansiedad en 2020, a los 28 años”.',
    condition: { itemId: 'M02', skipWhen: ['no'] },
    subfields: [
      sub('diagnostico', 'diagnóstico', ['diagnóstico', 'diagnostico', 'ansiedad', 'depresión', 'depresion', 'trastorno']),
      sub('fechas', 'fechas de diagnóstico', ['diagnóstico', 'diagnostico', 'año', 'fecha']),
      sub('edades', 'edades al diagnóstico', ['edad', 'años']),
    ],
  },

  // C. Objetivo (3)
  {
    id: 'O01',
    sectionId: 'C',
    label: 'Objetivo de la consulta',
    prompt: '¿Cuál es el objetivo de tu consulta? Cuéntame con tus palabras qué te gustaría lograr y por qué.',
    type: 'narrative',
    clarify: '¿Qué te gustaría conseguir con esta consulta?',
    subfields: [sub('objetivo', 'objetivo de la consulta', ['objetivo', 'lograr', 'espero', 'quiero'])],
  },
  {
    id: 'O02',
    sectionId: 'C',
    label: 'Pasiones',
    prompt: '¿Qué es lo que más te apasiona? Descríbelo con un poco de detalle.',
    type: 'narrative',
    clarify: '¿Qué actividades o temas te apasionan de verdad?',
    subfields: [sub('pasiones', 'pasiones', ['apasiona', 'amo', 'encanta', 'disfruto'])],
  },
  {
    id: 'O03',
    sectionId: 'C',
    label: 'Lo que detestas',
    prompt: '¿Qué es lo que más detestas? Descríbelo con un poco de detalle.',
    type: 'narrative',
    clarify: '¿Qué cosas te disgustan o detestas más?',
    subfields: [sub('detestas', 'lo que detestas', ['detesto', 'odio', 'disgusta', 'molesta'])],
  },

  // D. Origen e infancia (11)
  {
    id: 'Q01',
    sectionId: 'D',
    label: 'Finalidad en la vida',
    prompt: '¿Cuál sientes que es tu finalidad en la vida? Cuéntamela con tus propias palabras y algo de detalle.',
    type: 'narrative',
    clarify: '¿Qué sentido o finalidad le encuentras a tu vida hoy?',
    subfields: [sub('finalidad', 'finalidad en la vida', ['finalidad', 'sentido', 'propósito', 'proposito', 'vida'])],
  },
  {
    id: 'Q02',
    sectionId: 'D',
    label: 'Hijo deseado',
    prompt: '¿Fuiste un hijo deseado? Puedes responder “sí”, “no” o “no sé”; si quieres, cuéntame un poco más.',
    type: 'short',
    clarify: '¿Sabes si tu llegada fue deseada o esperada por tus padres? Puedes responder “sí”, “no” o “no sé”.',
    subfields: [sub('deseado', 'hijo deseado', ['desead', 'esperad', 'querían', 'querian', 'no sé', 'no se'])],
  },
  {
    id: 'Q03',
    sectionId: 'D',
    label: 'Sexo deseado',
    prompt: '¿Te querían del sexo que eres? Puedes responder “sí”, “no” o “no sé”.',
    type: 'short',
    clarify: '¿Sabes si tus padres esperaban o querían un hijo de tu sexo? Puedes responder “sí”, “no” o “no sé”.',
    subfields: [sub('sexo', 'sexo deseado', ['sexo', 'niño', 'niña', 'nino', 'nina', 'esperaban'])],
  },
  {
    id: 'Q04',
    sectionId: 'D',
    label: 'Origen del nombre',
    prompt: '¿Por qué o por quién eligieron tu nombre?',
    type: 'narrative',
    clarify: '¿Sabes quién eligió tu nombre o por qué te lo pusieron?',
    subfields: [sub('nombre', 'origen del nombre', ['nombre', 'eligieron', 'pusieron', 'abuel', 'padre', 'madre'])],
  },
  {
    id: 'Q05',
    sectionId: 'D',
    label: 'Fecha de nacimiento',
    prompt: '¿Tu fecha de nacimiento tiene relación con otra fecha importante de tu familia? Puedes responder “sí” o “no”; si es sí, dime cuál.',
    type: 'short',
    clarify: '¿Tu nacimiento coincidió con alguna fecha importante para tu familia? Puedes responder “sí” o “no”.',
    subfields: [sub('relacion', 'relación con otra fecha', ['fecha', 'coincid', 'aniversario', 'cumpleaños', 'cumpleanos', 'no'])],
  },
  {
    id: 'Q06',
    sectionId: 'D',
    label: 'Embarazo y parto',
    prompt:
      '¿Cómo fueron los 9 meses previos a tu embarazo, el embarazo y tu parto? Incluye cómo era la situación emocional y económica de tus padres.',
    type: 'narrative',
    clarify:
      'Para completar: ¿cómo era la situación emocional de tus padres, cómo era la económica y cómo fue el embarazo o el parto?',
    example: 'Por ejemplo: “Mi madre estaba feliz, había dificultad económica y el parto fue normal”.',
    subfields: [
      sub('emocional', 'situación emocional de los padres', ['emocional', 'feliz', 'triste', 'preocup', 'ansiedad']),
      sub('economica', 'situación económica', ['económ', 'econom', 'dinero', 'trabajo', 'dificultad']),
      sub('embarazo_parto', 'embarazo y parto', ['embarazo', 'parto', 'meses', 'nacimiento']),
    ],
  },
  {
    id: 'Q07',
    sectionId: 'D',
    label: 'Lactancia',
    prompt: '¿Te amamantaron y durante cuánto tiempo?',
    type: 'narrative',
    clarify: '¿Te amamantaron y durante cuánto tiempo? Si no lo sabes, dime “no sé”.',
    subfields: [
      sub('lactancia', 'si fue amamantado', ['sí', 'si', 'no', 'mamar', 'lactancia', 'seno']),
      sub('duracion', 'duración de la lactancia', ['mes', 'año', 'ano', 'tiempo', 'seman']),
    ],
  },
  {
    id: 'Q08',
    sectionId: 'D',
    label: 'Infancia',
    prompt: '¿Ocurrió algún acontecimiento importante en tu infancia? Si es así, cuéntame cuál o cuáles; si no, escribe “ninguno”.',
    type: 'short',
    clarify: '¿Qué acontecimientos importantes recuerdas de tu infancia, aunque no parezcan graves? Si no hubo, escribe “ninguno”.',
    subfields: [sub('acontecimientos', 'acontecimientos de la infancia', ['infancia', 'recuerdo', 'pasó', 'paso', 'colegio', 'familia'])],
  },
  {
    id: 'Q09',
    sectionId: 'D',
    label: 'Salud',
    prompt: '¿Cómo es y ha sido tu salud? Cuéntame con un poco de detalle, por ejemplo si has tenido enfermedades o tratamientos.',
    type: 'narrative',
    clarify: '¿Cómo describirías tu salud a lo largo de la vida?',
    subfields: [sub('salud', 'salud', ['salud', 'enferm', 'bien', 'mal', 'médic', 'medic'])],
  },
  {
    id: 'Q10',
    sectionId: 'D',
    label: 'Cuidados en la infancia',
    prompt: '¿De qué personas recibiste cuidados, afecto y educación en tu infancia?',
    type: 'narrative',
    clarify: '¿Quiénes te cuidaron, te dieron afecto y te educaron en la infancia?',
    subfields: [sub('cuidadores', 'personas cuidadoras', ['madre', 'padre', 'abuel', 'tía', 'tia', 'herman', 'cuid'])],
  },
  {
    id: 'Q11',
    sectionId: 'D',
    label: 'Mascotas',
    prompt: '¿Qué mascotas hubo en casa?',
    type: 'narrative',
    clarify: '¿Tuviste mascotas en casa? ¿Cuáles? Si no, dime “ninguna”.',
    subfields: [sub('mascotas', 'mascotas', ['perro', 'gato', 'mascota', 'animal', 'ninguna', 'ningun'])],
  },

  // E. Familia (8)
  {
    id: 'Q12',
    sectionId: 'E',
    label: 'Lugar entre hermanos',
    prompt: '¿Qué lugar ocupas entre tus hermanos, incluyendo abortos y fallecidos?',
    type: 'narrative',
    clarify: '¿Eres el mayor, el menor o el del medio? Incluye hermanos fallecidos o abortos si aplica.',
    example: 'Por ejemplo: “Soy la mayor; no hubo abortos ni hermanos fallecidos”.',
    subfields: [
      sub('posicion', 'posición entre hermanos', [
        'mayor',
        'menor',
        'medio',
        'primero',
        'primer',
        'segundo',
        'segund',
        'tercero',
        'tercer',
        'cuarto',
        'lugar',
        'puesto',
        'posicion',
        'posición',
        'numero',
        'número',
        'unico',
        'único',
      ]),
      sub('abortos', 'abortos', ['aborto', 'perdi'], true),
      sub('fallecidos', 'hermanos fallecidos', ['fallec', 'murió', 'murio', 'muert'], true),
    ],
  },
  {
    id: 'Q13',
    sectionId: 'E',
    label: 'Relación con hermanos',
    prompt: '¿Cómo era la relación con tus hermanos mientras convivían? ¿Y cómo es hoy?',
    type: 'narrative',
    clarify: 'Para completar: ¿cómo era la relación mientras convivían y cómo es hoy?',
    example: 'Por ejemplo: “Convivíamos bien y hoy la relación es cercana”.',
    subfields: [
      sub('convivencia', 'relación mientras convivían', ['conviv', 'relación', 'relacion', 'casa']),
      sub('actualidad', 'relación actual', ['hoy', 'actual', 'ahora']),
    ],
  },
  {
    id: 'Q14',
    sectionId: 'E',
    label: 'Atención entre hermanos',
    prompt: '¿Algún hermano acaparó más la atención que los demás? ¿Por qué?',
    type: 'narrative',
    clarify: '¿Algún hermano recibió más atención? ¿A qué crees que se debió?',
    subfields: [sub('atencion', 'atención recibida', ['atención', 'atencion', 'prefer', 'consentid', 'más', 'mas'])],
  },
  {
    id: 'Q16',
    sectionId: 'E',
    label: 'Economía del hogar',
    prompt:
      '¿Qué circunstancias económicas hubo en tu hogar? ¿Hubo carencias o derroches? ¿Se amaba o se despreciaba el dinero?',
    type: 'narrative',
    clarify: 'Para completar: ¿había carencias o derroches y qué actitud se tenía hacia el dinero?',
    example: 'Por ejemplo: “Había carencias, no derroches; se valoraba el dinero”.',
    subfields: [
      sub('circunstancias', 'circunstancias económicas', ['económ', 'econom', 'dinero', 'hogar']),
      sub('carencias', 'carencias', ['carenc', 'falt', 'necesidad', 'pobre']),
      sub('derroches', 'derroches', ['derroch', 'gast', 'lujo']),
      sub('actitud', 'actitud hacia el dinero', ['amaba', 'despreci', 'valor', 'dinero']),
    ],
  },
  {
    id: 'Q17',
    sectionId: 'E',
    label: 'Parejas anteriores de los padres',
    prompt: '¿Tu padre o tu madre tuvieron parejas anteriores? ¿Hubo hijos de otras parejas?',
    type: 'narrative',
    clarify: '¿Alguno de tus padres tuvo parejas anteriores o hijos de otras relaciones?',
    example: 'Por ejemplo: “Mi padre tuvo una pareja anterior y un hijo; mi madre no”.',
    subfields: [
      sub('padre', 'parejas anteriores del padre', ['padre', 'papá', 'papa']),
      sub('madre', 'parejas anteriores de la madre', ['madre', 'mamá', 'mama']),
      sub('otros_hijos', 'hijos de otras parejas', ['hijo', 'hermanastr', 'otra pareja']),
    ],
  },
  {
    id: 'Q18',
    sectionId: 'E',
    label: 'Familia actual',
    prompt: '¿Quiénes forman parte de la familia actual?',
    type: 'narrative',
    clarify: '¿Quiénes componen tu familia hoy?',
    subfields: [sub('familia', 'familia actual', ['familia', 'pareja', 'hijo', 'padre', 'madre', 'herman'])],
  },
  {
    id: 'Q19',
    sectionId: 'E',
    label: 'Sucesos graves en la familia',
    prompt:
      '¿Hubo muertes tempranas, abortos, hijos que nacieron muertos, mujeres que murieron en el parto, accidentes, hechos graves, suicidios, enfermedades, sucesos de guerra o peleas por herencias en la familia?',
    type: 'narrative',
    clarify:
      'Para completar: ¿hubo muertes tempranas, abortos, accidentes, suicidios, enfermedades, guerras o disputas por herencia? Si no hubo, dime “ninguno”.',
    example: 'Por ejemplo: “Ninguno; no hubo muertes, abortos, accidentes, suicidios ni guerras”.',
    subfields: [
      sub('muertes', 'muertes tempranas', ['murió', 'murio', 'muerte', 'fallec']),
      sub('abortos', 'abortos', ['aborto', 'perdi']),
      sub('accidentes', 'accidentes', ['accident']),
      sub('suicidios', 'suicidios', ['suicid']),
      sub('enfermedades', 'enfermedades', ['enferm']),
      sub('guerra', 'guerra', ['guerra', 'violencia']),
      sub('herencias', 'herencias', ['herencia', 'testamento']),
    ],
  },
  {
    id: 'Q20',
    sectionId: 'E',
    label: 'Temas secretos',
    prompt: '¿Existen en la familia temas secretos, temas de los que no se puede hablar? Puedes responder “sí” o “no”; si es sí, cuéntame cuáles.',
    type: 'short',
    clarify: '¿Hay temas de los que en tu familia no se habla o se evitan? Puedes responder “sí” o “no”.',
    subfields: [sub('secretos', 'temas secretos', ['secreto', 'no se habla', 'tabú', 'tabu', 'evit'])],
  },

  // F. Árbol familiar (1, guided)
  {
    id: 'Q21',
    sectionId: 'F',
    label: 'Árbol genealógico',
    prompt:
      'Vamos a armar tu árbol familiar. Empecemos por tus padres: nombres, fechas de nacimiento y muerte, y causas de muerte si las conoces.',
    type: 'structure',
    format: 'family_tree',
    clarify: 'Puedes darme solo lo que sepas. Si falta algo, escribe “no tengo información”.',
    subfields: [sub('personas', 'personas del árbol', ['padre', 'madre', 'abuel', 'herman', 'tío', 'tio'])],
    q21Steps: [
      {
        key: 'parents',
        label: 'Padres',
        prompt:
          'Empecemos por tus padres. ¿Me das sus nombres, fechas de nacimiento y muerte, y causas de muerte si las conoces?',
        subfields: [
          sub('padres', 'padres', ['padre', 'madre', 'papá', 'mamá']),
          sub('fechas', 'fechas', ['naci', 'murió', 'murio', 'fecha']),
          sub('causas', 'causas de muerte', ['causa', 'murió de', 'murio de']),
        ],
      },
      {
        key: 'grandparents',
        label: 'Abuelos',
        prompt:
          'Ahora tus abuelos paternos y maternos. Nombres, fechas y causas de muerte si las conoces. Si no tienes información, dilo.',
        subfields: [
          sub('abuelos', 'abuelos', ['abuel']),
          sub('fechas', 'fechas', ['naci', 'murió', 'murio', 'fecha']),
          sub('causas', 'causas de muerte', ['causa', 'murió de', 'murio de']),
        ],
      },
      {
        key: 'great_grandparents',
        label: 'Bisabuelos',
        prompt:
          'Si tienes información, cuéntame de tus bisabuelos: nombres, fechas y causas de muerte. Si no, escribe “no tengo información”.',
        subfields: [sub('bisabuelos', 'bisabuelos', ['bisabuel']), sub('datos', 'datos', ['naci', 'murió', 'murio', 'causa'])],
      },
      {
        key: 'siblings_extended',
        label: 'Hermanos, tíos y primos',
        prompt:
          'Para terminar el árbol: hermanos, tíos, tías y primos. Incluye nombres y datos que recuerdes. Si no tienes información, dilo.',
        subfields: [
          sub('hermanos', 'hermanos', ['herman']),
          sub('tios', 'tíos y tías', ['tío', 'tio', 'tía', 'tia']),
          sub('primos', 'primos', ['prim']),
        ],
      },
    ],
  },

  // G. Sucesos significativos (2)
  {
    id: 'Q22',
    sectionId: 'G',
    label: 'Sucesos significativos',
    prompt: 'Menciona los sucesos significativos de tu vida e incluye la edad que tenías en cada uno.',
    type: 'narrative',
    clarify: '¿Qué sucesos importantes recuerdas y a qué edad ocurrieron? Incluye al menos uno con edad.',
    example: 'Por ejemplo: “A los 20 años me mudé sola y a los 28 empecé terapia”.',
    subfields: [sub('sucesos', 'sucesos significativos', ['suceso', 'recuerdo', 'pasó', 'paso']), sub('edades', 'edades', ['años', 'edad'])],
  },
  {
    id: 'G02',
    sectionId: 'G',
    label: 'Edad de autonomía económica',
    prompt: '¿A qué edad te independizaste económicamente de tus padres?',
    type: 'number',
    format: 'age_autonomy',
    min: 12,
    max: 100,
    optional: true,
    clarify: '¿A qué edad empezaste a sostenerte económicamente? Si no aplica, escribe “no aplica”.',
    subfields: [sub('edad_autonomia', 'edad de autonomía económica', ['años', 'edad', 'independic'])],
  },

  // H. Cierre (1)
  {
    id: 'C01',
    sectionId: 'H',
    label: 'Confirmación del resumen',
    prompt: '¿El resumen que te mostré está completo y correcto?',
    type: 'confirmation',
    format: 'confirmation',
    clarify: '¿El resumen está correcto? Responde “sí” o dime qué quieres corregir.',
    subfields: [sub('confirmacion', 'confirmación del resumen', ['sí', 'si', 'correcto', 'no', 'corregir'])],
  },
];

export const ITEM_MAP = new Map(ITEMS.map((item) => [item.id, item]));
export const SECTION_MAP = new Map(SECTIONS.map((section) => [section.id, section]));
export const ITEM_IDS = ITEMS.map((item) => item.id);

export function getItem(id) {
  return ITEM_MAP.get(id) || null;
}

export function getSection(id) {
  return SECTION_MAP.get(id) || null;
}

export function sectionItems(sectionId) {
  return ITEMS.filter((item) => item.sectionId === sectionId);
}

export function firstItemOfSection(sectionId) {
  return sectionItems(sectionId)[0] || null;
}

export function itemIndex(itemId) {
  return ITEM_IDS.indexOf(itemId);
}

export function nextItemId(itemId) {
  const idx = itemIndex(itemId);
  if (idx < 0 || idx >= ITEMS.length - 1) return null;
  return ITEMS[idx + 1].id;
}

export function nextSectionId(sectionId) {
  const idx = SECTIONS.findIndex((s) => s.id === sectionId);
  if (idx < 0 || idx >= SECTIONS.length - 1) return null;
  return SECTIONS[idx + 1].id;
}

export function sectionOfItem(itemId) {
  return getItem(itemId)?.sectionId || null;
}

export function totalItems() {
  return ITEMS.length;
}

export function catalogSummary() {
  return {
    version: SURVEY_VERSION,
    total: ITEMS.length,
    sections: SECTIONS.map((s) => ({
      id: s.id,
      name: s.name,
      short: s.short,
      count: sectionItems(s.id).length,
      items: sectionItems(s.id).map((i) => ({ id: i.id, label: i.label, type: i.type, critical: !!i.critical })),
    })),
  };
}
