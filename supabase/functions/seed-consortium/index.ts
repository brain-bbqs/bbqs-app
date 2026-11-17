import { createClient } from "npm:@supabase/supabase-js@2.39.3";
import { getCorsHeaders, requireAdmin } from "../_shared/auth.ts";
import { orcidKey } from "../_shared/identity-keys.ts";
import { emailKey, findOrCreateInvestigator, kgSession, loadPeople, matchPeople, type PersonKey } from "../_shared/kg-write.ts";

interface ConsortiumPerson {
  name: string;
  email: string;
  secondary_emails: string[];
  orcid: string;
  affiliation: string;
  role: string;
  working_groups: string[];
}

const CONSORTIUM_PEOPLE: ConsortiumPerson[] = [
  {
    "name": "Chuck Mikell",
    "email": "charles.mikell@stonybrookmedicine.edu",
    "secondary_emails": [
      "chuck.mikell@gmail.com"
    ],
    "orcid": "0000-0002-0701-2325",
    "affiliation": "Stony Brook Medicine",
    "role": "Principal Investigator (PI)",
    "working_groups": [
      "WG-Analytics"
    ]
  },
  {
    "name": "Kenneth Shepard",
    "email": "shepard@ee.columbia.edu",
    "secondary_emails": [],
    "orcid": "",
    "affiliation": "Columbia University",
    "role": "Principal Investigator (PI)",
    "working_groups": [
      "WG-Devices"
    ]
  },
  {
    "name": "Talmo Pereira",
    "email": "talmo@salk.edu",
    "secondary_emails": [
      "talmo@talmolab.org"
    ],
    "orcid": "0000-0001-9075-8365",
    "affiliation": "Salk Institute for Biological Studies",
    "role": "Principal Investigator (PI)",
    "working_groups": [
      "WG-Analytics"
    ]
  },
  {
    "name": "Brendan Ito",
    "email": "brendan.ito@nyulangone.org",
    "secondary_emails": [
      "itobrendan@gmail.com"
    ],
    "orcid": "",
    "affiliation": "NYU Langone",
    "role": "Postdoc/Grad Student",
    "working_groups": [
      "WG-Analytics",
      "WG-Devices"
    ]
  },
  {
    "name": "Jongwoon Kim",
    "email": "jongwoon.kim@nyulangone.org",
    "secondary_emails": [
      "jk4975@columbia.edu"
    ],
    "orcid": "",
    "affiliation": "NYU, Columbia University",
    "role": "Postdoc/Grad Student",
    "working_groups": []
  },
  {
    "name": "Cristina Savin",
    "email": "cs5360@nyu.edu",
    "secondary_emails": [],
    "orcid": "0000-0002-3414-8244",
    "affiliation": "NYU",
    "role": "Principal Investigator (PI)",
    "working_groups": [
      "WG-Analytics",
      "WG-Standards"
    ]
  },
  {
    "name": "Robert Froemke",
    "email": "robert.froemke@med.nyu.edu",
    "secondary_emails": [
      "rfroemke@gmail.com"
    ],
    "orcid": "0000-0002-1230-6811",
    "affiliation": "NYU Grossman School of Medicine",
    "role": "Principal Investigator (PI)",
    "working_groups": [
      "WG-Analytics"
    ]
  },
  {
    "name": "Dmitry Batenkov",
    "email": "dima@basis.ai",
    "secondary_emails": [
      "dima.batenkov@gmail.com"
    ],
    "orcid": "0000-0003-2679-0138",
    "affiliation": "Basis Research Institute",
    "role": "Research Staff (Scientist and others)",
    "working_groups": [
      "WG-Analytics"
    ]
  },
  {
    "name": "Bartul Mimica",
    "email": "bmimica@princeton.edu",
    "secondary_emails": [
      "mimica.bartul@gmail.com"
    ],
    "orcid": "0000-0001-6404-0560",
    "affiliation": "Princeton Neurosicence Institute",
    "role": "Postdoc/Grad Student",
    "working_groups": [
      "WG-Analytics"
    ]
  },
  {
    "name": "Ralph Peterson",
    "email": "ralph@basis.ai",
    "secondary_emails": [
      "ralph.emilio.peterson@gmail.com"
    ],
    "orcid": "0000-0002-2692-5955",
    "affiliation": "Basis Research Institute / NYU",
    "role": "Research Staff (Scientist and others), Postdoc/Grad Student",
    "working_groups": [
      "WG-Analytics",
      "WG-Devices"
    ]
  },
  {
    "name": "Emily Mackevicius",
    "email": "emily@basis.ai",
    "secondary_emails": [],
    "orcid": "0000-0001-6593-4398",
    "affiliation": "Basis Research Institute",
    "role": "Co-Investigator",
    "working_groups": [
      "WG-Analytics",
      "WG-Standards"
    ]
  },
  {
    "name": "Sima Mofakham",
    "email": "sima.mofakham@stonybrookmedicine.edu",
    "secondary_emails": [
      "s.mofakham@gmail.com"
    ],
    "orcid": "0000-0002-4509-6080",
    "affiliation": "Stony Brook University Hospital",
    "role": "Principal Investigator (PI)",
    "working_groups": [
      "WG-Analytics",
      "WG-Devices",
      "WG-ELSI"
    ]
  },
  {
    "name": "Dayu Lin",
    "email": "dayu.lin@nyulangone.org",
    "secondary_emails": [],
    "orcid": "0000-0003-2006-0791",
    "affiliation": "NYU Langone Medical Center",
    "role": "Principal Investigator (PI)",
    "working_groups": [
      "WG-Analytics"
    ]
  },
  {
    "name": "Nishant Rao",
    "email": "nishant.rao@yale.edu",
    "secondary_emails": [
      "raonishant.2016@gmail.com"
    ],
    "orcid": "0009-0007-4272-8189",
    "affiliation": "Yale University",
    "role": "Research Staff (Scientist and others), Postdoc/Grad Student",
    "working_groups": [
      "WG-Analytics",
      "WG-Devices",
      "WG-ELSI"
    ]
  },
  {
    "name": "Caleb Scott-Joseph",
    "email": "calebsj@sas.upenn.edu",
    "secondary_emails": [
      "calebscottjoseph@gmail.com"
    ],
    "orcid": "",
    "affiliation": "University of Pennsylvania",
    "role": "Postdoc/Grad Student",
    "working_groups": []
  },
  {
    "name": "Adam Friedman",
    "email": "adam.friedman2@mssm.edu",
    "secondary_emails": [
      "adamfriedman03@gmail.com"
    ],
    "orcid": "",
    "affiliation": "Icahn School of Medicine at Mount Sinai",
    "role": "Research Staff (Scientist and others)",
    "working_groups": [
      "WG-Analytics"
    ]
  },
  {
    "name": "Taylor Wise",
    "email": "taylor.wise@yale.edu",
    "secondary_emails": [],
    "orcid": "",
    "affiliation": "Yale University",
    "role": "Postdoc/Grad Student",
    "working_groups": [
      "WG-Analytics"
    ]
  },
  {
    "name": "Lensky Augustin",
    "email": "lensky.augustin@psych.utah.edu",
    "secondary_emails": [
      "lenskya50@gmail.com"
    ],
    "orcid": "",
    "affiliation": "University of Utah",
    "role": "Postdoc/Grad Student",
    "working_groups": [
      "WG-Analytics",
      "WG-Devices"
    ]
  },
  {
    "name": "Niegil Francis",
    "email": "nm4075@nyu.edu",
    "secondary_emails": [],
    "orcid": "",
    "affiliation": "New York University",
    "role": "Research Staff (Scientist and others)",
    "working_groups": [
      "WG-Analytics"
    ]
  },
  {
    "name": "Joseph Colonel",
    "email": "joseph.colonel@mssm.edu",
    "secondary_emails": [],
    "orcid": "0009-0000-5516-9231",
    "affiliation": "Psychiatry",
    "role": "Postdoc/Grad Student",
    "working_groups": [
      "WG-Analytics"
    ]
  },
  {
    "name": "Kay Sun",
    "email": "kaysuninf@gmail.com",
    "secondary_emails": [
      "xitao0xs@gmail.com"
    ],
    "orcid": "",
    "affiliation": "Columbia Univerisity / Mount Sanai volunteer",
    "role": "Research Staff (Scientist and others)",
    "working_groups": [
      "WG-Analytics",
      "WG-Devices"
    ]
  },
  {
    "name": "Aydin Tasevac",
    "email": "aydintasevac@gmail.com",
    "secondary_emails": [],
    "orcid": "",
    "affiliation": "University of Utah",
    "role": "Postdoc/Grad Student",
    "working_groups": [
      "WG-Analytics",
      "WG-Devices"
    ]
  },
  {
    "name": "Abigayle Fogarty",
    "email": "abigayle.fogarty@mssm.edu",
    "secondary_emails": [
      "afogarty234@gmail.com"
    ],
    "orcid": "",
    "affiliation": "Icahn School of Medicine at Mount Sinai",
    "role": "Research Staff (Scientist and others)",
    "working_groups": [
      "WG-Analytics",
      "WG-ELSI"
    ]
  },
  {
    "name": "Sara Sanchez-Alonso",
    "email": "sara.sanchez.alonso@yale.edu",
    "secondary_emails": [
      "sanchez.alonso.sara@gmail.com"
    ],
    "orcid": "",
    "affiliation": "Yale University",
    "role": "Research Staff (Scientist and others)",
    "working_groups": [
      "WG-Analytics",
      "WG-Devices",
      "WG-ELSI",
      "WG-Standards"
    ]
  },
  {
    "name": "Mara Baylis",
    "email": "mbaylis@berkeley.edu",
    "secondary_emails": [],
    "orcid": "",
    "affiliation": "UC Berkeley",
    "role": "Postdoc/Grad Student",
    "working_groups": [
      "WG-Analytics"
    ]
  },
  {
    "name": "Karmiella Ferster",
    "email": "karmiella.ferster@mssm.edu",
    "secondary_emails": [
      "karmiellaferster@gmail.com"
    ],
    "orcid": "0009-0001-3106-1979",
    "affiliation": "Icahn School of Medicine at Mount Sinai",
    "role": "Research Staff (Scientist and others), Admin",
    "working_groups": [
      "WG-Analytics",
      "WG-Devices",
      "WG-ELSI",
      "WG-Standards"
    ]
  },
  {
    "name": "Katherine Dokholyan",
    "email": "katherine.dokholyan@mssm.edu",
    "secondary_emails": [
      "katherine@dokholyan.org"
    ],
    "orcid": "",
    "affiliation": "Icahn School of Medicine At Mount Sinai",
    "role": "Research Staff (Scientist and others)",
    "working_groups": [
      "WG-ELSI",
      "WG-Standards"
    ]
  },
  {
    "name": "Michael Genecin",
    "email": "mpg8611@nyu.edu",
    "secondary_emails": [],
    "orcid": "0009-0006-3931-7752",
    "affiliation": "New York University, Center for Neural Science",
    "role": "Postdoc/Grad Student",
    "working_groups": [
      "WG-Analytics"
    ]
  },
  {
    "name": "Kun Zhao",
    "email": "cz2715@columbia.edu",
    "secondary_emails": [],
    "orcid": "",
    "affiliation": "Columbia University",
    "role": "Postdoc/Grad Student",
    "working_groups": [
      "WG-Analytics",
      "WG-Devices"
    ]
  },
  {
    "name": "Joost Wagenaar",
    "email": "joostw@seas.upenn.edu",
    "secondary_emails": [],
    "orcid": "",
    "affiliation": "University of Pennsylvania",
    "role": "Data Infrastructure support",
    "working_groups": [
      "WG-Analytics"
    ]
  },
  {
    "name": "Alessandra DallaVecchia",
    "email": "adallave@ucla.edu",
    "secondary_emails": [],
    "orcid": "0000-0002-4023-5141",
    "affiliation": "UCLA",
    "role": "Postdoc/Grad Student",
    "working_groups": []
  },
  {
    "name": "Eunyoung Kim",
    "email": "eunyoung.kim@nih.gov",
    "secondary_emails": [],
    "orcid": "",
    "affiliation": "NIH/NIMH/BRAIN Initiative",
    "role": "NIH Program",
    "working_groups": []
  },
  {
    "name": "Kari Johnson",
    "email": "kari.johnson@nih.gov",
    "secondary_emails": [
      "kariannejohnson23@gmail.com"
    ],
    "orcid": "",
    "affiliation": "NIH",
    "role": "NIH Program",
    "working_groups": []
  },
  {
    "name": "Mark Tiede",
    "email": "mark.tiede@yale.edu",
    "secondary_emails": [
      "mktiede@gmail.com"
    ],
    "orcid": "",
    "affiliation": "Dept. Psychiatry, Yale U.",
    "role": "Co-Investigator",
    "working_groups": [
      "WG-Analytics",
      "WG-Devices"
    ]
  },
  {
    "name": "Holly Moore",
    "email": "holly.moore@nih.gov",
    "secondary_emails": [
      "hm2035@gmail.com"
    ],
    "orcid": "",
    "affiliation": "NIH",
    "role": "NIH Program",
    "working_groups": [
      "WG-Analytics",
      "WG-Devices",
      "WG-ELSI",
      "WG-Standards"
    ]
  },
  {
    "name": "Joseph Monaco",
    "email": "joseph.monaco@nih.gov",
    "secondary_emails": [
      "jdmonaco@gmail.com"
    ],
    "orcid": "0000-0003-0792-8322",
    "affiliation": "NIH/BRAIN",
    "role": "NIH Program",
    "working_groups": []
  },
  {
    "name": "Shannon Gourley",
    "email": "shannon.gourley@emory.edu",
    "secondary_emails": [],
    "orcid": "0000-0002-7783-9379",
    "affiliation": "Emory University",
    "role": "Principal Investigator (PI)",
    "working_groups": []
  },
  {
    "name": "Wan Chen Lin",
    "email": "wanchenlin@berkeley.edu",
    "secondary_emails": [],
    "orcid": "",
    "affiliation": "UC Berkeley",
    "role": "Postdoc/Grad Student",
    "working_groups": [
      "WG-Analytics",
      "WG-Devices",
      "WG-Standards"
    ]
  },
  {
    "name": "Andrew MacAskill",
    "email": "a.macaskill@ucl.ac.uk",
    "secondary_emails": [
      "ucgbafm@ucl.ac.uk"
    ],
    "orcid": "0000-0002-0196-3779",
    "affiliation": "UCL",
    "role": "Co-Investigator",
    "working_groups": []
  },
  {
    "name": "Yi Zuo",
    "email": "yizuo@ucsc.edu",
    "secondary_emails": [],
    "orcid": "",
    "affiliation": "UCSC",
    "role": "Co-Investigator",
    "working_groups": [
      "WG-Analytics",
      "WG-Standards"
    ]
  },
  {
    "name": "Linda Wilbrecht",
    "email": "wilbrecht@berkeley.edu",
    "secondary_emails": [],
    "orcid": "",
    "affiliation": "UC Berkeley",
    "role": "Principal Investigator (PI)",
    "working_groups": [
      "WG-Analytics",
      "WG-Devices"
    ]
  },
  {
    "name": "Fang Yu Chang",
    "email": "stellachang1114@g.ucla.edu",
    "secondary_emails": [
      "fangyuchang2021@gmail.com"
    ],
    "orcid": "0000-0002-5511-3876",
    "affiliation": "UCLA",
    "role": "Research Staff (Scientist and others)",
    "working_groups": [
      "WG-Analytics",
      "WG-ELSI"
    ]
  },
  {
    "name": "Joy Hirsch",
    "email": "joy.hirsch@yale.edu",
    "secondary_emails": [
      "joyhirsch@yahoo.com"
    ],
    "orcid": "",
    "affiliation": "Yale University",
    "role": "Principal Investigator (PI)",
    "working_groups": []
  },
  {
    "name": "David Ostry",
    "email": "david.ostry@yale.edu",
    "secondary_emails": [],
    "orcid": "",
    "affiliation": "Yale Child Study Center",
    "role": "Co-Investigator",
    "working_groups": []
  },
  {
    "name": "Jared Reiling",
    "email": "reiling1@msu.edu",
    "secondary_emails": [
      "reiling1@msu.edu"
    ],
    "orcid": "0000-0003-1942-237X",
    "affiliation": "Michigan State University",
    "role": "Postdoc/Grad Student",
    "working_groups": []
  },
  {
    "name": "Amrita Nair",
    "email": "amrita.nair@yale.edu",
    "secondary_emails": [],
    "orcid": "",
    "affiliation": "Yale university",
    "role": "Research Staff (Scientist and others)",
    "working_groups": []
  },
  {
    "name": "Nader Nikbakht",
    "email": "nikbakht@mit.edu",
    "secondary_emails": [
      "nader.nikbakht@gmail.com"
    ],
    "orcid": "",
    "affiliation": "MIT",
    "role": "Research Staff (Scientist and others)",
    "working_groups": [
      "WG-Analytics",
      "WG-Devices"
    ]
  },
  {
    "name": "Adam Noah",
    "email": "adam@adamnoah.com",
    "secondary_emails": [
      "adam.noah@yale.edu"
    ],
    "orcid": "0000-0001-9773-2790",
    "affiliation": "Yale University",
    "role": "Co-Investigator, Research Staff (Scientist and others)",
    "working_groups": [
      "WG-Analytics"
    ]
  },
  {
    "name": "Suliman Sharif",
    "email": "sulstice@mit.edu",
    "secondary_emails": [
      "sharifsuliman1@gmail.com"
    ],
    "orcid": "0000-0002-1342-9258",
    "affiliation": "Massachusetts Institute of Technology",
    "role": "Research Staff (Scientist and others)",
    "working_groups": [
      "WG-Analytics",
      "WG-Devices",
      "WG-ELSI",
      "WG-Standards"
    ]
  },
  {
    "name": "Meaghan Perdue",
    "email": "mvperdue16@gmail.com",
    "secondary_emails": [
      "mvperdue@mit.edu"
    ],
    "orcid": "0000-0002-6113-9175",
    "affiliation": "UMass Chan Medical School",
    "role": "Admin",
    "working_groups": []
  },
  {
    "name": "Vincent Gracco",
    "email": "vincent.gracco@yale.edu",
    "secondary_emails": [
      "vgracco@gmail.com"
    ],
    "orcid": "",
    "affiliation": "Yale University",
    "role": "Co-Investigator",
    "working_groups": []
  },
  {
    "name": "Mang Gao",
    "email": "gao0624@gmail.com",
    "secondary_emails": [
      "gao0624@gmail.com"
    ],
    "orcid": "0009-0002-0379-8655",
    "affiliation": "Northwestern University",
    "role": "Postdoc/Grad Student",
    "working_groups": [
      "WG-Devices"
    ]
  },
  {
    "name": "Amelia Johnson",
    "email": "amelia.johnson.aj764@yale.edu",
    "secondary_emails": [
      "ameliammjohnson@gmail.com"
    ],
    "orcid": "",
    "affiliation": "Yale University",
    "role": "research assistant",
    "working_groups": [
      "WG-Analytics"
    ]
  },
  {
    "name": "Neha Thomas",
    "email": "neha.thomas@jhuapl.edu",
    "secondary_emails": [
      "nehatk17@gmail.com"
    ],
    "orcid": "",
    "affiliation": "JHU APL",
    "role": "Research Staff (Scientist and others)",
    "working_groups": [
      "WG-Analytics",
      "WG-Devices",
      "WG-Standards"
    ]
  },
  {
    "name": "Jeff Walker",
    "email": "jeffrey.walker@yale.edu",
    "secondary_emails": [],
    "orcid": "",
    "affiliation": "Yale University",
    "role": "Research Staff (Scientist and others)",
    "working_groups": [
      "WG-Analytics"
    ]
  },
  {
    "name": "Meghan Cum",
    "email": "meghan.cum@yale.edu",
    "secondary_emails": [],
    "orcid": "0009-0004-9299-992X",
    "affiliation": "Yale University",
    "role": "Postdoc/Grad Student",
    "working_groups": []
  },
  {
    "name": "Weikang Shi",
    "email": "weikang.shi@yale.edu",
    "secondary_emails": [],
    "orcid": "",
    "affiliation": "Yale",
    "role": "Postdoc/Grad Student",
    "working_groups": []
  },
  {
    "name": "Anirvan Nandy",
    "email": "anirvan.nandy@yale.edu",
    "secondary_emails": [
      "anirvan.nandy@gmail.com (for google groups)",
      "anirvan.nandy@gmail.com"
    ],
    "orcid": "0000-0002-4225-5349",
    "affiliation": "Yale University",
    "role": "Principal Investigator (PI)",
    "working_groups": [
      "WG-Devices"
    ]
  },
  {
    "name": "Steve Chang",
    "email": "steve.chang@yale.edu",
    "secondary_emails": [
      "stevewcc@gmail.com"
    ],
    "orcid": "0000-0003-4160-7549",
    "affiliation": "Yale University",
    "role": "Principal Investigator (PI)",
    "working_groups": []
  },
  {
    "name": "Yuyi Chang",
    "email": "chang.1560@osu.edu",
    "secondary_emails": [
      "yuyichang10@gmail.com",
      "yuyi.melon@gmail.com"
    ],
    "orcid": "",
    "affiliation": "The Ohio State University",
    "role": "Postdoc/Grad Student",
    "working_groups": [
      "WG-Analytics",
      "WG-Devices"
    ]
  },
  {
    "name": "Marcia Patchan",
    "email": "marcia.patchan@jhuapl.edu",
    "secondary_emails": [
      "mpatchan101@gmail.com"
    ],
    "orcid": "0000-0002-0485-0403",
    "affiliation": "JHU/APL",
    "role": "Research Staff (Scientist and others)",
    "working_groups": []
  },
  {
    "name": "Teneille Brown",
    "email": "teneille.brown@law.utah.edu",
    "secondary_emails": [],
    "orcid": "0000-0002-3398-163X",
    "affiliation": "University of Utah",
    "role": "Co-Investigator",
    "working_groups": [
      "WG-ELSI"
    ]
  },
  {
    "name": "\u00c1lvaro Vega Hidalgo",
    "email": "alvarovh@umich.edu",
    "secondary_emails": [],
    "orcid": "0000-0003-4088-8027",
    "affiliation": "University of Michigan",
    "role": "Postdoc/Grad Student",
    "working_groups": [
      "WG-Analytics",
      "WG-Devices",
      "WG-ELSI",
      "WG-Standards"
    ]
  },
  {
    "name": "Thore Bergman",
    "email": "thore@umich.edu",
    "secondary_emails": [],
    "orcid": "0000-0002-9615-5001",
    "affiliation": "University of Michigan",
    "role": "Field site director, collaborator",
    "working_groups": [
      "WG-Analytics",
      "WG-Devices"
    ]
  },
  {
    "name": "Jennie Grammer",
    "email": "grammer@ucla.edu",
    "secondary_emails": [],
    "orcid": "",
    "affiliation": "UCLA",
    "role": "Principal Investigator (PI)",
    "working_groups": [
      "WG-ELSI"
    ]
  },
  {
    "name": "Nithin Sugavanam",
    "email": "sugavanam.3@osu.edu",
    "secondary_emails": [],
    "orcid": "",
    "affiliation": "Ohio State university",
    "role": "Research Staff (Scientist and others), Postdoc/Grad Student",
    "working_groups": [
      "WG-Analytics",
      "WG-Devices"
    ]
  },
  {
    "name": "Luis Garcia",
    "email": "la.garcia@utah.edu",
    "secondary_emails": [
      "luis.antonio.garcia2@gmail.com"
    ],
    "orcid": "0000-0002-5111-0694",
    "affiliation": "University of Utah",
    "role": "Co-Investigator",
    "working_groups": [
      "WG-Analytics",
      "WG-Devices",
      "WG-ELSI",
      "WG-Standards"
    ]
  },
  {
    "name": "Mauricio Rangel-Gomez",
    "email": "mauricio.rangel-gomez@nih.gov",
    "secondary_emails": [
      "maorangelnih@gmail.com"
    ],
    "orcid": "",
    "affiliation": "NIMH",
    "role": "NIH Program",
    "working_groups": [
      "WG-Analytics",
      "WG-Devices",
      "WG-ELSI",
      "WG-Standards"
    ]
  },
  {
    "name": "Alireza Kazemi",
    "email": "alireza.kazemi@utah.edu",
    "secondary_emails": [
      "alireza.kzmi@gmail.com"
    ],
    "orcid": "0000-0001-8944-1459",
    "affiliation": "University of Utah",
    "role": "Postdoc/Grad Student",
    "working_groups": [
      "WG-Analytics",
      "WG-Devices"
    ]
  },
  {
    "name": "Uros Topalovic",
    "email": "uros.topalovic@duke.edu",
    "secondary_emails": [
      "urostopalovic@g.ucla.edu"
    ],
    "orcid": "0000-0003-4005-7979",
    "affiliation": "Duke University",
    "role": "Postdoc/Grad Student",
    "working_groups": [
      "WG-Devices"
    ]
  },
  {
    "name": "Alex Cabral",
    "email": "acabral30@gatech.edu",
    "secondary_emails": [
      "alexcabral13@gmail.com"
    ],
    "orcid": "",
    "affiliation": "Georgia Tech",
    "role": "Postdoc/Grad Student",
    "working_groups": [
      "WG-Analytics",
      "WG-Devices",
      "WG-ELSI"
    ]
  },
  {
    "name": "Marcela Benitez",
    "email": "marcela.benitez@emory.edu",
    "secondary_emails": [],
    "orcid": "",
    "affiliation": "Emory",
    "role": "Co-Investigator",
    "working_groups": []
  },
  {
    "name": "Grace Hwang",
    "email": "grace.hwang@nih.gov",
    "secondary_emails": [
      "gracehwang532@gmail.com"
    ],
    "orcid": "0000-0002-3335-8688",
    "affiliation": "NIH",
    "role": "NIH Program",
    "working_groups": [
      "WG-Analytics",
      "WG-Devices"
    ]
  },
  {
    "name": "Karen David",
    "email": "karen.david@nih.gov",
    "secondary_emails": [
      "kakamonster@gmail.com"
    ],
    "orcid": "",
    "affiliation": "NIH",
    "role": "NIH Program",
    "working_groups": []
  },
  {
    "name": "Brian Gitahi",
    "email": "brian.gitahi@yale.edu",
    "secondary_emails": [],
    "orcid": "",
    "affiliation": "Yale University",
    "role": "Postdoc/Grad Student",
    "working_groups": [
      "WG-Analytics"
    ]
  },
  {
    "name": "Jacinta Beehner",
    "email": "jbeehner@umich.edu",
    "secondary_emails": [],
    "orcid": "0000-0001-6566-6872",
    "affiliation": "University of Michigan",
    "role": "Principal Investigator (PI)",
    "working_groups": [
      "WG-Analytics",
      "WG-Devices"
    ]
  },
  {
    "name": "Aditya Bhise",
    "email": "bhisea@chop.edu",
    "secondary_emails": [
      "abhise8181@gmail.com"
    ],
    "orcid": "0000-0002-9144-172X",
    "affiliation": "Children\u2019s Hospital of Philadelphia",
    "role": "Clinical Research Coordinator",
    "working_groups": [
      "WG-Devices",
      "WG-Standards"
    ]
  },
  {
    "name": "Shelly Flagel",
    "email": "sflagel@med.umich.edu",
    "secondary_emails": [
      "sflagel@umich.edu"
    ],
    "orcid": "",
    "affiliation": "University of Michigan",
    "role": "Principal Investigator (PI)",
    "working_groups": [
      "WG-Analytics"
    ]
  },
  {
    "name": "William Nacci",
    "email": "wn15@rice.edu",
    "secondary_emails": [],
    "orcid": "0009-0000-9565-0783",
    "affiliation": "Rice University",
    "role": "Postdoc/Grad Student",
    "working_groups": [
      "WG-Analytics",
      "WG-Devices",
      "WG-ELSI",
      "WG-Standards"
    ]
  },
  {
    "name": "Yibei Chen",
    "email": "yibei@mit.edu",
    "secondary_emails": [
      "yibeichan@gmail.com"
    ],
    "orcid": "0000-0003-2882-0900",
    "affiliation": "MIT",
    "role": "Postdoc/Grad Student",
    "working_groups": [
      "WG-Analytics",
      "WG-Devices",
      "WG-ELSI",
      "WG-Standards"
    ]
  },
  {
    "name": "Cody Baker",
    "email": "cody.c.baker.phd@gmail.com",
    "secondary_emails": [],
    "orcid": "0000-0002-0829-4790",
    "affiliation": "Dartmouth College",
    "role": "Research Staff (Scientist and others)",
    "working_groups": [
      "WG-Analytics",
      "WG-Devices",
      "WG-Standards"
    ]
  },
  {
    "name": "Emre Ertin",
    "email": "ertin.1@osu.edu",
    "secondary_emails": [
      "emreertin@gmail.com"
    ],
    "orcid": "0000-0001-7815-0728",
    "affiliation": "Ohio State University",
    "role": "Principal Investigator (PI)",
    "working_groups": [
      "WG-Analytics",
      "WG-Devices"
    ]
  },
  {
    "name": "Agatha Lenartowicz",
    "email": "alenarto@g.ucla.edu",
    "secondary_emails": [],
    "orcid": "0000-0001-8015-8251",
    "affiliation": "UCLA",
    "role": "Principal Investigator (PI)",
    "working_groups": [
      "WG-Analytics"
    ]
  },
  {
    "name": "Tyler Albarran",
    "email": "talbarran3@gatech.edu",
    "secondary_emails": [
      "tyalbarr@gmail.com"
    ],
    "orcid": "0009-0009-1642-4549",
    "affiliation": "Georgia Institute of Technology",
    "role": "Postdoc/Grad Student",
    "working_groups": [
      "WG-Analytics"
    ]
  },
  {
    "name": "Stephanie Prince",
    "email": "smprince@lbl.gov",
    "secondary_emails": [],
    "orcid": "0000-0002-3083-6955",
    "affiliation": "Lawrence Berkeley National Laboratory",
    "role": "Research Staff (Scientist and others)",
    "working_groups": [
      "WG-Analytics",
      "WG-Standards"
    ]
  },
  {
    "name": "Ryan Ly",
    "email": "rly@lbl.gov",
    "secondary_emails": [
      "ryanly@gmail.com"
    ],
    "orcid": "0000-0001-9238-0642",
    "affiliation": "Lawrence Berkeley National Lab",
    "role": "Research Staff (Scientist and others)",
    "working_groups": [
      "WG-Analytics",
      "WG-Standards"
    ]
  },
  {
    "name": "Brent Kious",
    "email": "brent.kious@hsc.utah.edu",
    "secondary_emails": [
      "brentkious@gmail.com"
    ],
    "orcid": "",
    "affiliation": "University of Utah",
    "role": "Co-Investigator",
    "working_groups": [
      "WG-ELSI"
    ]
  },
  {
    "name": "Dimitris Samaras",
    "email": "samaras@cs.stonybrook.edu",
    "secondary_emails": [],
    "orcid": "0000-0002-1373-0294",
    "affiliation": "Sony Brook University",
    "role": "Consultant",
    "working_groups": [
      "WG-Analytics",
      "WG-Devices"
    ]
  },
  {
    "name": "Emily Kuschner",
    "email": "kuschnere@chop.edu",
    "secondary_emails": [
      "emilykuschner@gmail.com"
    ],
    "orcid": "0000-0003-1251-1468",
    "affiliation": "CHOP/UPenn",
    "role": "Research Staff (Scientist and others)",
    "working_groups": []
  },
  {
    "name": "Eran Klein",
    "email": "kleineuw@uw.edu",
    "secondary_emails": [
      "eran.klein@gmail.com"
    ],
    "orcid": "0000-0002-0132-5777",
    "affiliation": "Oregon Health and Science University, University of Washington",
    "role": "Co-Investigator",
    "working_groups": [
      "WG-ELSI"
    ]
  },
  {
    "name": "Sara Goering",
    "email": "sgoering@uw.edu",
    "secondary_emails": [],
    "orcid": "",
    "affiliation": "University of Washington",
    "role": "Co-Investigator",
    "working_groups": [
      "WG-ELSI"
    ]
  },
  {
    "name": "Ashley Feinsinger",
    "email": "afeinsinger@mednet.ucla.edu",
    "secondary_emails": [
      "afeinsinger@gmail.com"
    ],
    "orcid": "0000-0002-0251-8810",
    "affiliation": "UCLA",
    "role": "Co-Investigator",
    "working_groups": [
      "WG-ELSI"
    ]
  },
  {
    "name": "Sequioa Smith",
    "email": "sequioasmith@ufl.edu",
    "secondary_emails": [],
    "orcid": "0000-0002-4704-2852",
    "affiliation": "University of Florida",
    "role": "Postdoc/Grad Student",
    "working_groups": []
  },
  {
    "name": "Jarl Haggerty",
    "email": "jarl.haggerty@pennmedicine.upenn.edu",
    "secondary_emails": [
      "jarlhaggerty@gmail.com"
    ],
    "orcid": "",
    "affiliation": "University of Pennsylvania",
    "role": "Application Developer",
    "working_groups": []
  },
  {
    "name": "Bijan Pesaran",
    "email": "pesaran@upenn.edu",
    "secondary_emails": [
      "pesaran@gmail com"
    ],
    "orcid": "",
    "affiliation": "UPenn",
    "role": "Research Staff (Scientist and others)",
    "working_groups": []
  },
  {
    "name": "anqi wu",
    "email": "awu36@gatech.edu",
    "secondary_emails": [],
    "orcid": "",
    "affiliation": "georgia institute of technology",
    "role": "Co-Investigator",
    "working_groups": [
      "WG-Analytics"
    ]
  },
  {
    "name": "Dana Schloesser",
    "email": "dana.schloesser@nih.gov",
    "secondary_emails": [
      "drdanags@gmail.com"
    ],
    "orcid": "",
    "affiliation": "NIH/OBSSR",
    "role": "NIH Program",
    "working_groups": [
      "WG-Analytics",
      "WG-Devices",
      "WG-ELSI",
      "WG-Standards"
    ]
  },
  {
    "name": "Sandy Hider",
    "email": "sandy.hider@jhuapl.edu",
    "secondary_emails": [
      "sandy.hider@gmail.com"
    ],
    "orcid": "0009-0002-0323-6986",
    "affiliation": "JHU/APL",
    "role": "Software Developer",
    "working_groups": [
      "WG-Analytics"
    ]
  },
  {
    "name": "Lisa Blaskey",
    "email": "blaskey@chop.edu",
    "secondary_emails": [
      "lisablaskeydecamp@gmail.com"
    ],
    "orcid": "0000-0002-5909-3622",
    "affiliation": "Children's Hospital of Philadelphia",
    "role": "Co-Investigator",
    "working_groups": [
      "WG-ELSI"
    ]
  },
  {
    "name": "Mina Kim",
    "email": "kimm8@chop.edu",
    "secondary_emails": [
      "minakimphd@gmail.com"
    ],
    "orcid": "0000-0003-2019-5944",
    "affiliation": "Children's Hospital of Philadelphia",
    "role": "Research Staff (Scientist and others)",
    "working_groups": [
      "WG-ELSI"
    ]
  },
  {
    "name": "Shuren Xia",
    "email": "sx67@scarletmail.rutgers.edu",
    "secondary_emails": [],
    "orcid": "0009-0002-9213-1384",
    "affiliation": "Rutgers University",
    "role": "Postdoc/Grad Student",
    "working_groups": [
      "WG-Analytics",
      "WG-Devices"
    ]
  },
  {
    "name": "Jorge Ortiz",
    "email": "jorge.ortiz@rutgers.edu",
    "secondary_emails": [
      "jorge.ortiz.nyc1981@gmail.com"
    ],
    "orcid": "0000-0003-3325-1298",
    "affiliation": "Rutgers University",
    "role": "Principal Investigator (PI)",
    "working_groups": [
      "WG-Analytics"
    ]
  },
  {
    "name": "Taqiya Ehsan",
    "email": "te137@echo.rutgers.edu",
    "secondary_emails": [
      "te137@scarletmail.rutgers.edu"
    ],
    "orcid": "",
    "affiliation": "Rutgers University",
    "role": "Postdoc/Grad Student",
    "working_groups": [
      "WG-ELSI"
    ]
  },
  {
    "name": "Tucker Lancaster",
    "email": "tlancaster6@gatech.edu",
    "secondary_emails": [
      "tuckerlancaster@gmail.com"
    ],
    "orcid": "0000-0003-4074-7128",
    "affiliation": "Georgia institute of technology",
    "role": "Postdoc/Grad Student",
    "working_groups": []
  },
  {
    "name": "Sankar Alagapan",
    "email": "sankar.alagapan@gatech.edu",
    "secondary_emails": [
      "sankar.alagapan@gmail.com"
    ],
    "orcid": "0000-0002-2056-5450",
    "affiliation": "Georgia Institute of Technology",
    "role": "Co-Investigator",
    "working_groups": [
      "WG-Analytics",
      "WG-Devices"
    ]
  },
  {
    "name": "Tanya St. John",
    "email": "tstjohn@uw.edu",
    "secondary_emails": [],
    "orcid": "",
    "affiliation": "University of Washington Autism Center",
    "role": "Research Staff (Scientist and others)",
    "working_groups": []
  },
  {
    "name": "John Welsh",
    "email": "jwelshp@gmail.com",
    "secondary_emails": [],
    "orcid": "0000-0002-1012-4360",
    "affiliation": "Seattle Children's",
    "role": "Principal Investigator (PI)",
    "working_groups": [
      "WG-Analytics",
      "WG-Devices",
      "WG-ELSI"
    ]
  },
  {
    "name": "Tim Roberts",
    "email": "robertstim@chop.edu",
    "secondary_emails": [],
    "orcid": "0000-0001-7320-4870",
    "affiliation": "Children's Hospital of Philadelphia",
    "role": "Principal Investigator (PI)",
    "working_groups": [
      "WG-Analytics"
    ]
  },
  {
    "name": "Kate MacDuffie",
    "email": "kate.macduffie@seattlechildrens.org",
    "secondary_emails": [
      "kmacduffie@gmail.com"
    ],
    "orcid": "0000-0003-1252-4373",
    "affiliation": "Seattle Children's Research Institute",
    "role": "Co-Investigator",
    "working_groups": [
      "WG-ELSI"
    ]
  },
  {
    "name": "Annette Estes",
    "email": "estesa@uw.edu",
    "secondary_emails": [],
    "orcid": "0000-0003-2687-4155",
    "affiliation": "University of Washington",
    "role": "Co-Investigator",
    "working_groups": []
  },
  {
    "name": "Jeff Munson",
    "email": "jeffmun@uw.edu",
    "secondary_emails": [
      "jeffmunson@gmail.com"
    ],
    "orcid": "0000-0003-1798-8927",
    "affiliation": "University of Washington",
    "role": "Co-Investigator, Data Manager/Submitter",
    "working_groups": [
      "WG-Analytics",
      "WG-ELSI"
    ]
  },
  {
    "name": "David Kennedy",
    "email": "david.kennedy@umassmed.edu",
    "secondary_emails": [
      "dnkennedy@umassmed.edu"
    ],
    "orcid": "0000-0002-9377-0797",
    "affiliation": "University of Massachusetts Chan Medical School",
    "role": "Principal Investigator (PI)",
    "working_groups": [
      "WG-Analytics",
      "WG-Standards"
    ]
  },
  {
    "name": "Nicole Stock",
    "email": "nicole.stock@jhuapl.edu",
    "secondary_emails": [
      "nicoleelizabeth888@gmail.com"
    ],
    "orcid": "",
    "affiliation": "JHU/APL",
    "role": "Research Staff (Scientist and others)",
    "working_groups": [
      "WG-Standards"
    ]
  },
  {
    "name": "Christopher Rozell",
    "email": "crozell@gatech.edu",
    "secondary_emails": [
      "christopher.rozell@gmail.com"
    ],
    "orcid": "0000-0001-5173-1661",
    "affiliation": "Georgia Institute of Technology",
    "role": "Principal Investigator (PI)",
    "working_groups": [
      "WG-ELSI"
    ]
  },
  {
    "name": "Yaroslav Halchenko",
    "email": "yoh@dartmouth.edu",
    "secondary_emails": [
      "yarikoptic@gmail.com"
    ],
    "orcid": "0000-0003-3456-2493",
    "affiliation": "Dartmouth college",
    "role": "Co-Investigator",
    "working_groups": [
      "WG-Standards"
    ]
  },
  {
    "name": "Maryam Shanechi",
    "email": "shanechi@usc.edu",
    "secondary_emails": [],
    "orcid": "",
    "affiliation": "University of Southern California",
    "role": "Principal Investigator (PI)",
    "working_groups": [
      "WG-Analytics"
    ]
  },
  {
    "name": "Joshua Jacobs",
    "email": "joshua.jacobs@columbia.edu",
    "secondary_emails": [
      "joshuajacobs@uchicago.edu"
    ],
    "orcid": "0000-0003-1807-6882",
    "affiliation": "Columbia University",
    "role": "Principal Investigator (PI)",
    "working_groups": [
      "WG-Analytics"
    ]
  },
  {
    "name": "Lauren Diaz",
    "email": "lauren.diaz@jhuapl.edu",
    "secondary_emails": [
      "lauren.c.d2000@gmail.com"
    ],
    "orcid": "",
    "affiliation": "JHU/APL",
    "role": "Ember/DCAIC team",
    "working_groups": [
      "WG-Devices"
    ]
  },
  {
    "name": "Eva Dyer",
    "email": "evadyer@gatech.edu",
    "secondary_emails": [],
    "orcid": "",
    "affiliation": "Georgia Tech",
    "role": "Principal Investigator (PI)",
    "working_groups": [
      "WG-Analytics"
    ]
  },
  {
    "name": "Patrick McGrath",
    "email": "pmcgrath7@gatech.edu",
    "secondary_emails": [
      "ptmcgrat@gmail.com"
    ],
    "orcid": "0000-0002-1598-3746",
    "affiliation": "Georgia Institute of Technology",
    "role": "Principal Investigator (PI)",
    "working_groups": [
      "WG-Analytics",
      "WG-Devices"
    ]
  },
  {
    "name": "Caleb Kemere",
    "email": "caleb.kemere@rice.edu",
    "secondary_emails": [],
    "orcid": "0000-0003-2054-0234",
    "affiliation": "Rice University",
    "role": "Principal Investigator (PI)",
    "working_groups": [
      "WG-Analytics",
      "WG-Devices"
    ]
  },
  {
    "name": "Gordon Shepherd",
    "email": "g-shepherd@northwestern.edu",
    "secondary_emails": [
      "gmgshepherd@gmail.com"
    ],
    "orcid": "",
    "affiliation": "Northwestern University",
    "role": "Principal Investigator (PI)",
    "working_groups": []
  },
  {
    "name": "Nancy Padilla Coreano",
    "email": "npadillacoreano@ufl.edu",
    "secondary_emails": [],
    "orcid": "",
    "affiliation": "University of Florida",
    "role": "Principal Investigator (PI)",
    "working_groups": []
  },
  {
    "name": "Vivek Prakash",
    "email": "vprakash@miami.edu",
    "secondary_emails": [
      "viveknprakash@gmail.com"
    ],
    "orcid": "0000-0003-4569-6462",
    "affiliation": "University of Miami",
    "role": "Co-Investigator",
    "working_groups": [
      "WG-Analytics"
    ]
  },
  {
    "name": "Claire Kendell",
    "email": "ckendell@seas.upenn.edu",
    "secondary_emails": [],
    "orcid": "0000-0002-1896-4698",
    "affiliation": "University of Pennsylvania",
    "role": "Postdoc/Grad Student",
    "working_groups": [
      "WG-Devices"
    ]
  },
  {
    "name": "Mengsen Zhang",
    "email": "mengsen@msu.edu",
    "secondary_emails": [
      "mengsenzhang@gmail.com"
    ],
    "orcid": "0000-0003-3085-152X",
    "affiliation": "Michigan State University",
    "role": "Principal Investigator (PI)",
    "working_groups": [
      "WG-Analytics"
    ]
  },
  {
    "name": "Satrajit Ghosh",
    "email": "satra@mit.edu",
    "secondary_emails": [
      "satrajit.ghosh@gmail.com"
    ],
    "orcid": "",
    "affiliation": "MIT",
    "role": "Principal Investigator (PI)",
    "working_groups": []
  },
  {
    "name": "Jyl Boline",
    "email": "jylboline@informedminds.info",
    "secondary_emails": [
      "jylboline@gmail.com"
    ],
    "orcid": "0000-0001-5232-8364",
    "affiliation": "Informed Minds Inc.",
    "role": "Project Manager",
    "working_groups": []
  },
  {
    "name": "Rahul Hingorani",
    "email": "rahul.hingorani@jhuapl.edu",
    "secondary_emails": [
      "rhingorani3@gmail.com"
    ],
    "orcid": "",
    "affiliation": "JHU/APL",
    "role": "Research Staff (Scientist and others)",
    "working_groups": [
      "WG-Analytics",
      "WG-Devices",
      "WG-Standards"
    ]
  },
  {
    "name": "Marc Schmidt",
    "email": "marcschm@sas.upenn.edu",
    "secondary_emails": [],
    "orcid": "",
    "affiliation": "University of Pennsylvania",
    "role": "Principal Investigator (PI)",
    "working_groups": [
      "WG-Analytics",
      "WG-Devices"
    ]
  },
  {
    "name": "Kailin Zhuang",
    "email": "kailin.zhuang@berkeley.edu",
    "secondary_emails": [],
    "orcid": "0000-0001-9233-534X",
    "affiliation": "University of California, Berkeley",
    "role": "Postdoc/Grad Student",
    "working_groups": [
      "WG-Analytics",
      "WG-Standards"
    ]
  },
  {
    "name": "Katalin Gothard",
    "email": "kgothard@arizona.edu",
    "secondary_emails": [
      "gothard94@gmail.com"
    ],
    "orcid": "0000-0001-9642-2985",
    "affiliation": "The University of Arizona",
    "role": "con sultant",
    "working_groups": [
      "WG-Devices"
    ]
  },
  {
    "name": "Hongkun Zhu",
    "email": "hz2555@columbia.edu",
    "secondary_emails": [],
    "orcid": "0009-0007-2560-9639",
    "affiliation": "Columbia Univeristy",
    "role": "Postdoc/Grad Student",
    "working_groups": [
      "WG-Analytics",
      "WG-Devices"
    ]
  },
  {
    "name": "Melissa Kline Struhl",
    "email": "mekline@mit.edu",
    "secondary_emails": [
      "melissa.e.kline@gmail.com"
    ],
    "orcid": "0000-0003-2217-9331",
    "affiliation": "Massachusetts Institute of Technology",
    "role": "Research Staff (Scientist and others), (DCAIC)",
    "working_groups": [
      "WG-Standards"
    ]
  },
  {
    "name": "Gaurav Patel",
    "email": "ghp2114@cumc.columbia.edu",
    "secondary_emails": [
      "gauravpatel@gmail.com"
    ],
    "orcid": "0000-0003-0028-2098",
    "affiliation": "Columbia University",
    "role": "Co-Investigator",
    "working_groups": []
  },
  {
    "name": "Cheryl Corcoran",
    "email": "cheryl.corcoran@mssm.edu",
    "secondary_emails": [
      "cherylcorcoranmd@gmail.com"
    ],
    "orcid": "",
    "affiliation": "Mount Sinai",
    "role": "Principal Investigator (PI)",
    "working_groups": [
      "WG-Analytics",
      "WG-Devices",
      "WG-ELSI",
      "WG-Standards"
    ]
  },
  {
    "name": "Yangjia Li",
    "email": "y.li7@columbia.edu",
    "secondary_emails": [],
    "orcid": "",
    "affiliation": "Columbia University",
    "role": "Research Staff (Scientist and others)",
    "working_groups": []
  },
  {
    "name": "Eric Yttri",
    "email": "eyttri@andrew.cmu.edu",
    "secondary_emails": [],
    "orcid": "0000-0002-7214-1481",
    "affiliation": "Carnegie Mellon University",
    "role": "Principal Investigator (PI)",
    "working_groups": [
      "WG-Analytics"
    ]
  },
  {
    "name": "Michael Tadross",
    "email": "michael.tadross@duke.edu",
    "secondary_emails": [
      "mtadross@gmail.com"
    ],
    "orcid": "0000-0002-7752-6380",
    "affiliation": "DUKE UNIVERSITY",
    "role": "Principal Investigator (PI)",
    "working_groups": []
  },
  {
    "name": "Cory Inman",
    "email": "cory.inman@psych.utah.edu",
    "secondary_emails": [
      "corysinman@gmail.com"
    ],
    "orcid": "",
    "affiliation": "University of Utah",
    "role": "Principal Investigator (PI)",
    "working_groups": [
      "WG-Analytics",
      "WG-Devices",
      "WG-ELSI",
      "WG-Standards"
    ]
  },
  {
    "name": "Mauricio Vallejo Martelo",
    "email": "mvallejomartelo@mednet.ucla.edu",
    "secondary_emails": [
      "mvallejomartelo@g.ucla.edu"
    ],
    "orcid": "0000-0002-8922-6895",
    "affiliation": "UCLA",
    "role": "Research Staff (Scientist and others)",
    "working_groups": [
      "WG-Analytics"
    ]
  },
  {
    "name": "Nicole Guittari",
    "email": "nicole.guittari@jhuapl.edu",
    "secondary_emails": [],
    "orcid": "",
    "affiliation": "Johns Hopkins Applied Physics Laboratory/EMBER",
    "role": "Research Staff (Scientist and others)",
    "working_groups": [
      "WG-ELSI",
      "WG-Standards"
    ]
  },
  {
    "name": "Mattson Ogg",
    "email": "mattson.ogg@jhuapl.edu",
    "secondary_emails": [
      "mattson.ogg@gmail.com"
    ],
    "orcid": "0009-0004-5583-0586",
    "affiliation": "Johns Hopkins Applied Physics Laboratory",
    "role": "Research Staff (Scientist and others)",
    "working_groups": [
      "WG-Analytics",
      "WG-Devices",
      "WG-ELSI",
      "WG-Standards"
    ]
  },
  {
    "name": "Dan Sanes",
    "email": "dhs1@nyu.edu",
    "secondary_emails": [],
    "orcid": "0000-0002-3783-6165",
    "affiliation": "New York University",
    "role": "Principal Investigator (PI)",
    "working_groups": [
      "WG-Analytics"
    ]
  },
  {
    "name": "Laura Cabrera",
    "email": "lcabrera@psu.edu",
    "secondary_emails": [
      "lyc5332@psu.edu"
    ],
    "orcid": "0000-0002-6220-7096",
    "affiliation": "Pennsylvania State University",
    "role": "Principal Investigator (PI)",
    "working_groups": [
      "WG-ELSI"
    ]
  },
  {
    "name": "Janine Simmons",
    "email": "simmonsj@mail.nih.gov",
    "secondary_emails": [],
    "orcid": "",
    "affiliation": "NIH/OBSSR",
    "role": "NIH Program",
    "working_groups": [
      "WG-Standards"
    ]
  },
  {
    "name": "Yvonne Bennett",
    "email": "yvonne.bennett@mail.nih.gov",
    "secondary_emails": [],
    "orcid": "",
    "affiliation": "NIMH",
    "role": "NIH Program",
    "working_groups": [
      "WG-Devices",
      "WG-ELSI",
      "WG-Standards"
    ]
  },
  {
    "name": "Erik Johnson",
    "email": "erik.c.johnson@jhuapl.edu",
    "secondary_emails": [
      "ejohns24@gmail.com"
    ],
    "orcid": "0000-0002-7397-8531",
    "affiliation": "JHU/APL",
    "role": "Research Staff (Scientist and others)",
    "working_groups": [
      "WG-ELSI",
      "WG-Standards"
    ]
  },
  {
    "name": "Kristofer Bouchard",
    "email": "kebouchard@berkeley.edu",
    "secondary_emails": [
      "kebouchard@lbl.gov"
    ],
    "orcid": "0000-0002-1974-4603",
    "affiliation": "UCB",
    "role": "Co-Investigator",
    "working_groups": [
      "WG-Analytics"
    ]
  },
  {
    "name": "Han Yi",
    "email": "han.yi@jhuapl.edu",
    "secondary_emails": [
      "hanyijhuapl@gmail.com"
    ],
    "orcid": "0000-0001-7152-3712",
    "affiliation": "Johns Hopkins University Applied Physics Laboratory",
    "role": "Co-Investigator",
    "working_groups": [
      "WG-Analytics",
      "WG-Devices",
      "WG-ELSI",
      "WG-Standards"
    ]
  },
  {
    "name": "Jennifer Wagner",
    "email": "jkw131@psu.edu",
    "secondary_emails": [],
    "orcid": "0000-0002-2278-0306",
    "affiliation": "Penn State University",
    "role": "Co-Investigator",
    "working_groups": [
      "WG-ELSI"
    ]
  },
  {
    "name": "Oliver Ruebel",
    "email": "oruebel@lbl.gov",
    "secondary_emails": [],
    "orcid": "0000-0001-9902-1984",
    "affiliation": "Lawrence Berkeley National Laboratory",
    "role": "Co-Investigator",
    "working_groups": [
      "WG-ELSI",
      "WG-Standards"
    ]
  },
  {
    "name": "Brock Wester",
    "email": "brock.wester@jhuapl.edu",
    "secondary_emails": [
      "brock.wester@gmail.com"
    ],
    "orcid": "0000-0002-1500-2143",
    "affiliation": "JHU/APL",
    "role": "Principal Investigator (PI)",
    "working_groups": [
      "WG-ELSI",
      "WG-Standards"
    ]
  },
  {
    "name": "stephen heisig",
    "email": "stephen.heisig@mssm.edu",
    "secondary_emails": [],
    "orcid": "",
    "affiliation": "Icahn School of Medicine",
    "role": "Research Staff (Scientist and others)",
    "working_groups": [
      "WG-Analytics",
      "WG-Devices"
    ]
  },
  {
    "name": "Tianqing Li",
    "email": "tianqing.li@duke.edu",
    "secondary_emails": [
      "tianqing.li98@gmail.com"
    ],
    "orcid": "",
    "affiliation": "Duke University",
    "role": "Postdoc/Grad Student",
    "working_groups": [
      "WG-Analytics"
    ]
  },
  {
    "name": "Muhammad Parvaz",
    "email": "muhammad.parvaz@mssm.edu",
    "secondary_emails": [
      "mparvaz@gmail.com"
    ],
    "orcid": "0000-0002-2671-2327",
    "affiliation": "Icahn School of Medicine at Mount Sinai",
    "role": "Principal Investigator (PI)",
    "working_groups": [
      "WG-Analytics",
      "WG-Devices"
    ]
  },
  {
    "name": "Alex Williams",
    "email": "aw4614@nyu.edu",
    "secondary_emails": [
      "awilliams@flatironinstitute.org"
    ],
    "orcid": "0000-0001-5853-103X",
    "affiliation": "New York University",
    "role": "Principal Investigator (PI)",
    "working_groups": [
      "WG-Analytics"
    ]
  },
  {
    "name": "Timothy Dunn",
    "email": "timothy.dunn@duke.edu",
    "secondary_emails": [
      "dunn.tw@gmail.com"
    ],
    "orcid": "",
    "affiliation": "Duke University",
    "role": "Principal Investigator (PI)",
    "working_groups": [
      "WG-Analytics"
    ]
  },
  {
    "name": "David Schneider",
    "email": "ds5577@nyu.edu",
    "secondary_emails": [],
    "orcid": "0000-0002-8945-2024",
    "affiliation": "New York University",
    "role": "Principal Investigator (PI)",
    "working_groups": [
      "WG-Analytics"
    ]
  }
];

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Require admin access
  const auth = await requireAdmin(req, corsHeaders);
  if (auth.error) return auth.error;

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  // Service-role writes name themselves and the admin who ran them (Principle X); without the header
  // they read 'unknown' in data_audit_log. Set on this server-side client only.
  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    global: { headers: { "x-bbqs-client": `seed-consortium:${auth.user?.email ?? auth.user?.id ?? "admin"}` } },
  });

  try {
    let created = 0;
    let updated = 0;
    let skipped = 0;
    const errors: string[] = [];
    const notes: string[] = [];

    // The people, read once and matched here (_shared/kg-write.ts): by email, primary or secondary
    // on either side (an email ilike on the primary column alone missed a member whose form address
    // is their second one), then by ORCID, then by name key. A name is a guess (namesakes exist):
    // a record it finds that carries another email, or one of several records with the name, is
    // somebody a curator has to tell apart, so nothing is written to it (matchPeople's `ambiguous`).
    // So a name only ever reuses a record that has no email (a RePORTER twin), and the
    // sync_member_groups trigger, which skips a record without an email and otherwise keys Google
    // Groups on it, is never fired for another person's address by a working_groups write from here.
    const kg = kgSession(supabase);
    const people = await loadPeople(kg);
    const ORDER: PersonKey[] = ["email", "orcid", "name"];

    for (const person of CONSORTIUM_PEOPLE) {
      try {
        const emails = [person.email, ...person.secondary_emails].map((e) => e.toLowerCase());
        const query = { name: person.name, email: emails[0], secondaryEmails: emails.slice(1), orcid: person.orcid || null };
        // An ORCID goes on a record only if no other record holds it: one ORCID is one person
        // (uq_investigators_orcid_key refuses a second once 20261117181500 is applied).
        const orcidHeldElsewhere = (id: string | null) => {
          const k = orcidKey(person.orcid);
          return !!k && people.some((r) => r.id !== id && orcidKey(r.orcid) === k);
        };
        const match = matchPeople(people, query, ORDER);
        // A name may only reuse a record that has no email. matchPeople already refuses one with
        // another email when this person has an email; this also holds for a roster entry without one.
        const nameOnly = match.by === "name" && !!match.row;
        if (match.ambiguous || (nameOnly && emailKey(match.row!.email))) {
          // For a curator: nothing is written to the record(s) found, and no second record is made.
          errors.push(`${person.name}: ${match.reason ?? `matched only by name to "${match.row!.name}" (id ${match.row!.id}), ` +
            "which has an email this roster entry has none to compare with: nothing was written to it"}`);
          continue;
        }
        const existing = match.row;
        if (nameOnly) {
          notes.push(`${person.name}: matched by name only, to "${existing!.name}" (id ${existing!.id}), which has no email: updated it; its email was left for a curator to confirm`);
        }

        if (existing) {
          const { data: current, error: readErr } = await supabase
            .from("investigators")
            .select("id, secondary_emails, orcid, working_groups, role")
            .eq("id", existing.id)
            .single();
          if (readErr || !current) {
            errors.push(`${person.name}: ${readErr?.message ?? "matched record not readable"}`);
            continue;
          }

          // Update with new data (merge, don't overwrite non-empty)
          const updates: Record<string, any> = {};

          if (person.secondary_emails.length > 0) {
            const existingSec = current.secondary_emails || [];
            const merged = [...new Set([...existingSec, ...person.secondary_emails.map(e => e.toLowerCase())])];
            updates.secondary_emails = merged;
          }

          if (person.orcid && !current.orcid) {
            if (orcidHeldElsewhere(current.id)) notes.push(`${person.name}: ORCID ${person.orcid} is on another record; not copied (merge them)`);
            else updates.orcid = person.orcid;
          }

          if (person.working_groups.length > 0) {
            const existingWg = current.working_groups || [];
            const merged = [...new Set([...existingWg, ...person.working_groups])];
            updates.working_groups = merged;
          }

          if (person.role && !current.role) {
            updates.role = person.role;
          }

          if (Object.keys(updates).length > 0) {
            const { error: updateErr } = await supabase.from("investigators").update(updates).eq("id", current.id);
            if (updateErr) {
              errors.push(`${person.name}: ${updateErr.message}`);
            } else {
              // Later people in this run are matched against what was just written.
              if (updates.orcid) existing.orcid = updates.orcid;
              if (updates.secondary_emails) existing.secondary_emails = updates.secondary_emails;
              updated++;
            }
          } else {
            skipped++;
          }
        } else {
          // Create the person, then their node (findOrCreateInvestigator writes the person first).
          if (person.orcid && orcidHeldElsewhere(null)) notes.push(`${person.name}: ORCID ${person.orcid} is on another record; not copied`);
          const made = await findOrCreateInvestigator(kg, {
            ...query, orcid: orcidHeldElsewhere(null) ? null : query.orcid,
          }, { extra: { working_groups: person.working_groups, role: person.role || null }, order: ORDER });

          if (!made.ok) {
            errors.push(`${person.name}: ${made.error}`);
          } else if (made.created) {
            created++;
          } else {
            skipped++;
            if (made.note) notes.push(`${person.name}: ${made.note}`);
          }
        }
      } catch (err) {
        errors.push(`${person.name}: ${err instanceof Error ? err.message : "unknown"}`);
      }
    }

    return new Response(
      JSON.stringify({ success: true, created, updated, skipped, errors: errors.length, errorDetails: errors.slice(0, 10), notes: notes.slice(0, 20) }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : "Unknown" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
