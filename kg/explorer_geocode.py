"""Curated org name -> (lat, lng) lookup for the BBQS Explorer globe/map views.

Static and hand-maintained on purpose (see kg/README.md "BBQS Explorer"): these are well-known US
research institutions, so a one-time curated table is lighter and more reliable than a runtime
geocoding API call/key. Keys match `bbqs:name` on `ResearchOrganization` nodes verbatim (including
the all-caps NIH RePORTER spelling most rows use) -- `BBQSKnowledgeGraph.export_explorer_json`
matches case-insensitively and reports anything it can't match under `unplaced_orgs` rather than
dropping it silently. Coordinates are the institution's main campus (city-level, not a precise
address).

Add a row here whenever `unplaced_orgs` in a fresh `bbqs_explorer.json` names a new one.
"""

ORG_COORDS = {
    "CALIFORNIA INSTITUTE OF TECHNOLOGY": (34.1377, -118.1253),
    "CARNEGIE-MELLON UNIVERSITY": (40.4433, -79.9436),
    "CEDARS-SINAI MEDICAL CENTER": (34.0759, -118.3800),
    "CHILDREN'S HOSP OF PHILADELPHIA": (39.9490, -75.1930),
    "COLUMBIA UNIVERSITY HEALTH SCIENCES": (40.8420, -73.9430),
    "DARTMOUTH COLLEGE": (43.7044, -72.2887),
    "DUKE UNIVERSITY": (36.0014, -78.9382),
    "GEORGIA INSTITUTE OF TECHNOLOGY": (33.7756, -84.3963),
    "HARVARD UNIVERSITY": (42.3770, -71.1167),
    "ICAHN SCHOOL OF MEDICINE AT MOUNT SINAI": (40.7900, -73.9530),
    "JOHNS HOPKINS UNIVERSITY": (39.3299, -76.6205),
    "MASSACHUSETTS INSTITUTE OF TECHNOLOGY": (42.3601, -71.0942),
    "MICHIGAN STATE UNIVERSITY": (42.7018, -84.4822),
    "NATIONAL INSTITUTES OF HEALTH": (39.0034, -77.1013),
    "NEW YORK UNIVERSITY": (40.7295, -73.9965),
    "NEW YORK UNIVERSITY SCHOOL OF MEDICINE": (40.7423, -73.9740),
    "NORTHWESTERN UNIVERSITY AT CHICAGO": (41.8955, -87.6221),
    "PENNSYLVANIA STATE UNIVERSITY": (40.7982, -77.8599),
    "RICE UNIVERSITY": (29.7174, -95.4018),
    "SEATTLE CHILDREN'S HOSPITAL": (47.6615, -122.2837),
    "STATE UNIVERSITY NEW YORK STONY BROOK": (40.9126, -73.1234),
    "STATE UNIVERSITY OF NEW YORK AT STONY BROOK": (40.9126, -73.1234),
    "UNIV OF MASSACHUSETTS MED SCH WORCESTER": (42.2634, -71.8090),
    "UNIV OF NORTH CAROLINA CHAPEL HILL": (35.9049, -79.0469),
    "UNIVERSITY OF ALABAMA AT BIRMINGHAM": (33.5023, -86.8083),
    "UNIVERSITY OF CALIFORNIA BERKELEY": (37.8719, -122.2585),
    "UNIVERSITY OF CALIFORNIA LOS ANGELES": (34.0689, -118.4452),
    "UNIVERSITY OF CALIFORNIA, SAN DIEGO": (32.8801, -117.2340),
    "UNIVERSITY OF FLORIDA": (29.6436, -82.3549),
    "UNIVERSITY OF MEMPHIS": (35.1189, -89.9370),
    "UNIVERSITY OF MICHIGAN AT ANN ARBOR": (42.2780, -83.7382),
    "UNIVERSITY OF MINNESOTA": (44.9740, -93.2277),
    "UNIVERSITY OF PENNSYLVANIA": (39.9522, -75.1932),
    "UNIVERSITY OF PITTSBURGH AT PITTSBURGH": (40.4444, -79.9608),
    "UNIVERSITY OF SOUTHERN CALIFORNIA": (34.0224, -118.2851),
    "UTAH STATE HIGHER EDUCATION SYSTEM--UNIVERSITY OF UTAH": (40.7649, -111.8421),
    "YALE UNIVERSITY": (41.3163, -72.9223),
}


def geocode(org_name: str):
    """(lat, lng) for org_name, matched case-insensitively, or None if not in the curated table."""
    return ORG_COORDS.get((org_name or "").strip().upper())
