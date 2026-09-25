# Prompt provenance audit, 2026-09-25

`research.prompt_versions` rows are inserted once and never updated, and until
f31bd8d a row was keyed by its declared version alone. Prompt text changed
several times without a version bump, so run records name a row whose text is
not what their code sent. Since f31bd8d the stored version carries a hash of the
text and schema, and this cannot recur. This audit covers the records made
before that.

## Method

For every commit since 2026-09-16 touching `packages/research/src`,
`packages/ai/src` or the synthesis prompt, each module's system prompt and
response schema were rebuilt from that commit's own code. Each record naming a
legacy (unhashed) row was matched to the commit in effect when it was created
(database and commits both at +03:00):

- **correct**: the row holds the text that commit sends.
- **names text it was not sent**: it does not, and the next commit sends the
  same text as this one, so the working tree very likely did too.
- **uncertain**: the text changed at the next commit, so the record fell in a
  window where uncommitted edits may have been what was sent.

The code at a commit is only evidence of what was sent: no request body was
stored (`request_storage_uri` is empty), so it cannot be proven.

## Result

- correct, text changed soon after: 2
- correct: 44
- names text it was not sent: 108
- uncertain: text was being changed: 51

The texts those records were sent are now stored as prompt rows under their
hashed labels (inserted 2026-09-25, nothing updated). The records themselves still
name the legacy rows: repointing them rewrites history, and is left to the
operator. `prompt-repoint-2026-09-25.sql` does it for the
"names text it was not sent" records only, in one transaction.

## Records naming text they were not sent

| table | record | run | created | module | names | code at |
|---|---|---|---|---|---|---|
| model_runs | `bb7ff3d8` | `91437292` | 2026-09-17 20:05Z | company_profile | 1.0.0 | bfa9aee |
| model_runs | `102ca0c3` | `91437292` | 2026-09-17 20:05Z | business_model | 1.0.0 | bfa9aee |
| model_runs | `9b0dcf86` | `91437292` | 2026-09-17 20:06Z | financial_quality | 1.0.0 | bfa9aee |
| model_runs | `60caafc5` | `91437292` | 2026-09-17 19:40Z | company_profile | 1.0.0 | bfa9aee |
| model_runs | `a2ea0f8f` | `91437292` | 2026-09-17 19:40Z | financial_quality | 1.0.0 | bfa9aee |
| model_runs | `746fb6c1` | `91437292` | 2026-09-17 20:06Z | commodity_exposure | 1.0.0 | bfa9aee |
| model_runs | `89dd3e0b` | `91437292` | 2026-09-17 22:04Z | company_profile | 1.1.0 | 87102fc |
| model_runs | `99b7a7ed` | `91437292` | 2026-09-17 22:04Z | business_model | 1.1.0 | 87102fc |
| model_runs | `a02036bf` | `91437292` | 2026-09-17 22:04Z | financial_quality | 1.1.0 | 87102fc |
| model_runs | `1b93afed` | `91437292` | 2026-09-17 22:04Z | commodity_exposure | 1.1.0 | 87102fc |
| model_runs | `cf1178c7` | `91437292` | 2026-09-17 22:04Z | capital_structure | 1.1.0 | 87102fc |
| model_runs | `1884c6ad` | `91437292` | 2026-09-17 22:04Z | industry_position | 1.1.0 | 87102fc |
| model_runs | `127d6f1a` | `91437292` | 2026-09-17 22:04Z | valuation_assumptions | 1.1.0 | 87102fc |
| model_runs | `3b2bf73d` | `91437292` | 2026-09-17 22:04Z | supply_chain_position | 1.2.0 | 87102fc |
| model_runs | `c264d20b` | `976079bf` | 2026-09-18 06:08Z | company_profile | 1.1.0 | 683cb9c |
| model_runs | `fb86c968` | `976079bf` | 2026-09-18 06:08Z | business_model | 1.1.0 | 683cb9c |
| model_runs | `7221d05c` | `976079bf` | 2026-09-18 06:09Z | financial_quality | 1.1.0 | 683cb9c |
| model_runs | `0e322f7e` | `976079bf` | 2026-09-18 06:09Z | commodity_exposure | 1.1.0 | 683cb9c |
| model_runs | `19a94467` | `976079bf` | 2026-09-18 06:09Z | industry_position | 1.1.0 | 683cb9c |
| model_runs | `c9cc146d` | `976079bf` | 2026-09-18 06:09Z | capital_structure | 1.1.0 | 683cb9c |
| model_runs | `088cf8ba` | `976079bf` | 2026-09-18 06:10Z | supply_chain_position | 1.2.0 | 683cb9c |
| model_runs | `b72743ce` | `976079bf` | 2026-09-18 06:10Z | valuation_assumptions | 1.1.0 | 683cb9c |
| model_runs | `7f6baeac` | `976079bf` | 2026-09-18 06:13Z | company_profile | 1.1.0 | 683cb9c |
| model_runs | `041021ab` | `976079bf` | 2026-09-18 06:13Z | business_model | 1.1.0 | 683cb9c |
| model_runs | `678a2dc0` | `976079bf` | 2026-09-18 06:13Z | financial_quality | 1.1.0 | 683cb9c |
| model_runs | `1f10476a` | `976079bf` | 2026-09-18 06:13Z | capital_structure | 1.1.0 | 683cb9c |
| model_runs | `66667873` | `976079bf` | 2026-09-18 06:13Z | commodity_exposure | 1.1.0 | 683cb9c |
| model_runs | `645efff0` | `976079bf` | 2026-09-18 06:13Z | industry_position | 1.1.0 | 683cb9c |
| model_runs | `fe4f58b2` | `976079bf` | 2026-09-18 06:13Z | supply_chain_position | 1.2.0 | 683cb9c |
| model_runs | `fdbc9a79` | `976079bf` | 2026-09-18 06:13Z | valuation_assumptions | 1.1.0 | 683cb9c |
| model_runs | `b01cff96` | `c631a0fe` | 2026-09-24 16:30Z | company_profile | 1.1.0 | 6ebea5f |
| model_runs | `625bb939` | `c631a0fe` | 2026-09-24 16:30Z | business_model | 1.1.0 | 6ebea5f |
| model_runs | `56972e88` | `c631a0fe` | 2026-09-24 16:30Z | financial_quality | 1.1.0 | 6ebea5f |
| model_runs | `d1280929` | `c631a0fe` | 2026-09-24 16:31Z | commodity_exposure | 1.1.0 | 6ebea5f |
| model_runs | `a404b61e` | `c631a0fe` | 2026-09-24 16:31Z | industry_position | 1.1.0 | 6ebea5f |
| model_runs | `f7719e68` | `c631a0fe` | 2026-09-24 16:31Z | capital_structure | 1.1.0 | 6ebea5f |
| model_runs | `61871bc9` | `c631a0fe` | 2026-09-24 16:31Z | supply_chain_position | 1.2.0 | 6ebea5f |
| model_runs | `4fa4a91f` | `c631a0fe` | 2026-09-24 16:32Z | valuation_assumptions | 1.1.0 | 6ebea5f |
| model_runs | `6e1348db` | `c631a0fe` | 2026-09-24 16:42Z | final_synthesis | 1.0.0 | 6ebea5f |
| model_runs | `947559b3` | `8701d374` | 2026-09-24 17:55Z | company_profile | 1.1.0 | 3d46079 |
| model_runs | `4c5ddb6e` | `8701d374` | 2026-09-24 17:55Z | business_model | 1.1.0 | 3d46079 |
| model_runs | `591695fd` | `8701d374` | 2026-09-24 17:55Z | financial_quality | 1.1.0 | 3d46079 |
| model_runs | `827f7e4c` | `8701d374` | 2026-09-24 17:55Z | industry_position | 1.1.0 | 3d46079 |
| model_runs | `b579ae95` | `8701d374` | 2026-09-24 17:55Z | management | 1.1.0 | 3d46079 |
| model_runs | `478c2e0c` | `8701d374` | 2026-09-24 17:56Z | capital_structure | 1.1.0 | 3d46079 |
| model_runs | `f54c6279` | `8701d374` | 2026-09-24 17:56Z | commodity_exposure | 1.1.0 | 3d46079 |
| model_runs | `8b5f9dfe` | `8701d374` | 2026-09-24 17:56Z | supply_chain_position | 1.2.0 | 3d46079 |
| model_runs | `c7213717` | `8701d374` | 2026-09-24 17:56Z | valuation_assumptions | 1.1.0 | 3d46079 |
| model_runs | `f9f88cda` | `8701d374` | 2026-09-24 17:57Z | project_pipeline | 1.1.0 | 3d46079 |
| model_runs | `bf46f6df` | `8701d374` | 2026-09-24 17:57Z | competitive_landscape | 1.1.0 | 3d46079 |
| model_runs | `3ca85f3d` | `8701d374` | 2026-09-24 17:57Z | catalysts | 1.1.0 | 3d46079 |
| model_runs | `69d597b6` | `8701d374` | 2026-09-24 17:58Z | risks | 1.1.0 | 3d46079 |
| model_runs | `81a0b767` | `8701d374` | 2026-09-24 17:58Z | bear_case | 1.1.0 | 3d46079 |
| model_runs | `45a4ce5c` | `8701d374` | 2026-09-24 18:12Z | final_synthesis | 1.0.0 | 3d46079 |
| module_runs | `2266c9b4` | `91437292` | 2026-09-17 20:05Z | company_profile | 1.0.0 | bfa9aee |
| module_runs | `a6fe4425` | `91437292` | 2026-09-17 20:05Z | business_model | 1.0.0 | bfa9aee |
| module_runs | `e015ca2a` | `91437292` | 2026-09-17 20:05Z | financial_quality | 1.0.0 | bfa9aee |
| module_runs | `e432f285` | `91437292` | 2026-09-17 20:06Z | capital_structure | 1.0.0 | bfa9aee |
| module_runs | `44aebe18` | `91437292` | 2026-09-17 19:40Z | company_profile | 1.0.0 | bfa9aee |
| module_runs | `b830bc19` | `91437292` | 2026-09-17 19:40Z | business_model | 1.0.0 | bfa9aee |
| module_runs | `fb9b835c` | `91437292` | 2026-09-17 19:40Z | financial_quality | 1.0.0 | bfa9aee |
| module_runs | `e13e52ca` | `91437292` | 2026-09-17 20:06Z | commodity_exposure | 1.0.0 | bfa9aee |
| module_runs | `9b36a981` | `91437292` | 2026-09-17 22:04Z | company_profile | 1.1.0 | 87102fc |
| module_runs | `dd508e68` | `91437292` | 2026-09-17 22:04Z | business_model | 1.1.0 | 87102fc |
| module_runs | `ccdfd4a0` | `91437292` | 2026-09-17 22:04Z | financial_quality | 1.1.0 | 87102fc |
| module_runs | `a17de16e` | `91437292` | 2026-09-17 22:04Z | commodity_exposure | 1.1.0 | 87102fc |
| module_runs | `43e62ae3` | `91437292` | 2026-09-17 22:04Z | capital_structure | 1.1.0 | 87102fc |
| module_runs | `9f372339` | `91437292` | 2026-09-17 22:04Z | industry_position | 1.1.0 | 87102fc |
| module_runs | `5d06aa52` | `91437292` | 2026-09-17 22:04Z | supply_chain_position | 1.2.0 | 87102fc |
| module_runs | `4637fc43` | `91437292` | 2026-09-17 22:04Z | valuation_assumptions | 1.1.0 | 87102fc |
| module_runs | `047e7300` | `976079bf` | 2026-09-18 06:08Z | company_profile | 1.1.0 | 683cb9c |
| module_runs | `fa9e2f52` | `976079bf` | 2026-09-18 06:08Z | business_model | 1.1.0 | 683cb9c |
| module_runs | `d71b3e26` | `976079bf` | 2026-09-18 06:08Z | financial_quality | 1.1.0 | 683cb9c |
| module_runs | `e2693b37` | `976079bf` | 2026-09-18 06:09Z | commodity_exposure | 1.1.0 | 683cb9c |
| module_runs | `ee4699fe` | `976079bf` | 2026-09-18 06:09Z | industry_position | 1.1.0 | 683cb9c |
| module_runs | `502b2eb9` | `976079bf` | 2026-09-18 06:09Z | capital_structure | 1.1.0 | 683cb9c |
| module_runs | `2d4be3e5` | `976079bf` | 2026-09-18 06:09Z | supply_chain_position | 1.2.0 | 683cb9c |
| module_runs | `4ca0a712` | `976079bf` | 2026-09-18 06:09Z | valuation_assumptions | 1.1.0 | 683cb9c |
| module_runs | `ff93789b` | `976079bf` | 2026-09-18 06:13Z | company_profile | 1.1.0 | 683cb9c |
| module_runs | `ca2a92d1` | `976079bf` | 2026-09-18 06:13Z | business_model | 1.1.0 | 683cb9c |
| module_runs | `1ee37c26` | `976079bf` | 2026-09-18 06:13Z | financial_quality | 1.1.0 | 683cb9c |
| module_runs | `b15d7863` | `976079bf` | 2026-09-18 06:13Z | commodity_exposure | 1.1.0 | 683cb9c |
| module_runs | `3d70499a` | `976079bf` | 2026-09-18 06:13Z | capital_structure | 1.1.0 | 683cb9c |
| module_runs | `d1faa835` | `976079bf` | 2026-09-18 06:13Z | industry_position | 1.1.0 | 683cb9c |
| module_runs | `b9beb50d` | `976079bf` | 2026-09-18 06:13Z | supply_chain_position | 1.2.0 | 683cb9c |
| module_runs | `10762b08` | `976079bf` | 2026-09-18 06:13Z | valuation_assumptions | 1.1.0 | 683cb9c |
| module_runs | `247b9e62` | `c631a0fe` | 2026-09-24 16:30Z | company_profile | 1.1.0 | 6ebea5f |
| module_runs | `da582172` | `c631a0fe` | 2026-09-24 16:30Z | business_model | 1.1.0 | 6ebea5f |
| module_runs | `59b72fb9` | `c631a0fe` | 2026-09-24 16:30Z | financial_quality | 1.1.0 | 6ebea5f |
| module_runs | `dcd2fed9` | `c631a0fe` | 2026-09-24 16:30Z | commodity_exposure | 1.1.0 | 6ebea5f |
| module_runs | `8606780d` | `c631a0fe` | 2026-09-24 16:30Z | industry_position | 1.1.0 | 6ebea5f |
| module_runs | `dfb1abaf` | `c631a0fe` | 2026-09-24 16:30Z | capital_structure | 1.1.0 | 6ebea5f |
| module_runs | `e08d387c` | `c631a0fe` | 2026-09-24 16:31Z | supply_chain_position | 1.2.0 | 6ebea5f |
| module_runs | `be4028d1` | `c631a0fe` | 2026-09-24 16:31Z | valuation_assumptions | 1.1.0 | 6ebea5f |
| module_runs | `8b484b4c` | `8701d374` | 2026-09-24 17:54Z | company_profile | 1.1.0 | 3d46079 |
| module_runs | `d464fd84` | `8701d374` | 2026-09-24 17:55Z | business_model | 1.1.0 | 3d46079 |
| module_runs | `d8f29d19` | `8701d374` | 2026-09-24 17:55Z | financial_quality | 1.1.0 | 3d46079 |
| module_runs | `273c84fc` | `8701d374` | 2026-09-24 17:55Z | industry_position | 1.1.0 | 3d46079 |
| module_runs | `e5cf3b45` | `8701d374` | 2026-09-24 17:55Z | management | 1.1.0 | 3d46079 |
| module_runs | `eed8d690` | `8701d374` | 2026-09-24 17:55Z | capital_structure | 1.1.0 | 3d46079 |
| module_runs | `a2f4303f` | `8701d374` | 2026-09-24 17:56Z | valuation_assumptions | 1.1.0 | 3d46079 |
| module_runs | `8510cfa2` | `8701d374` | 2026-09-24 17:56Z | project_pipeline | 1.1.0 | 3d46079 |
| module_runs | `89c50c69` | `8701d374` | 2026-09-24 17:56Z | competitive_landscape | 1.1.0 | 3d46079 |
| module_runs | `d6182a57` | `8701d374` | 2026-09-24 17:57Z | catalysts | 1.1.0 | 3d46079 |
| module_runs | `9419655c` | `8701d374` | 2026-09-24 17:57Z | risks | 1.1.0 | 3d46079 |
| module_runs | `32fb3ec6` | `8701d374` | 2026-09-24 17:58Z | bear_case | 1.1.0 | 3d46079 |
| module_runs | `2ba57ad2` | `8701d374` | 2026-09-24 17:55Z | commodity_exposure | 1.1.0 | 3d46079 |
| module_runs | `ea2e69f8` | `8701d374` | 2026-09-24 17:56Z | supply_chain_position | 1.2.0 | 3d46079 |

## Uncertain records (left as they are)

| table | record | run | created | module | names | code at |
|---|---|---|---|---|---|---|
| model_runs | `c5fbb67a` | `91437292` | 2026-09-17 20:56Z | company_profile | 1.1.0 | b484551 |
| model_runs | `1dd5dcbd` | `91437292` | 2026-09-17 20:56Z | business_model | 1.1.0 | b484551 |
| model_runs | `504c7ecc` | `91437292` | 2026-09-17 21:18Z | company_profile | 1.1.0 | b484551 |
| model_runs | `4fc9748e` | `91437292` | 2026-09-17 21:18Z | business_model | 1.1.0 | b484551 |
| model_runs | `8c59f84e` | `91437292` | 2026-09-17 21:18Z | financial_quality | 1.1.0 | b484551 |
| model_runs | `689873a8` | `91437292` | 2026-09-17 21:19Z | commodity_exposure | 1.1.0 | b484551 |
| model_runs | `747ad61b` | `91437292` | 2026-09-17 21:19Z | industry_position | 1.1.0 | b484551 |
| model_runs | `07cf233b` | `91437292` | 2026-09-17 21:19Z | capital_structure | 1.1.0 | b484551 |
| model_runs | `9dee8155` | `91437292` | 2026-09-17 21:19Z | management | 1.1.0 | b484551 |
| model_runs | `40510702` | `91437292` | 2026-09-17 21:19Z | valuation_assumptions | 1.1.0 | b484551 |
| model_runs | `da95ffec` | `91437292` | 2026-09-17 21:19Z | supply_chain_position | 1.2.0 | b484551 |
| model_runs | `a3933999` | `91437292` | 2026-09-17 21:20Z | project_pipeline | 1.1.0 | b484551 |
| model_runs | `7bb7e5fa` | `91437292` | 2026-09-17 21:20Z | competitive_landscape | 1.1.0 | b484551 |
| model_runs | `65f2ee91` | `91437292` | 2026-09-17 21:21Z | catalysts | 1.1.0 | b484551 |
| model_runs | `373cfa16` | `91437292` | 2026-09-17 21:21Z | risks | 1.1.0 | b484551 |
| model_runs | `cb1ef937` | `91437292` | 2026-09-17 21:21Z | bear_case | 1.1.0 | b484551 |
| model_runs | `54cff2f5` | `91437292` | 2026-09-17 21:28Z | company_profile | 1.1.0 | b484551 |
| model_runs | `9e04e57a` | `91437292` | 2026-09-17 21:28Z | business_model | 1.1.0 | b484551 |
| model_runs | `ea986f2d` | `91437292` | 2026-09-17 21:28Z | financial_quality | 1.1.0 | b484551 |
| model_runs | `322b4030` | `91437292` | 2026-09-17 21:28Z | commodity_exposure | 1.1.0 | b484551 |
| model_runs | `9cb5c06e` | `91437292` | 2026-09-17 21:28Z | industry_position | 1.1.0 | b484551 |
| model_runs | `e51a5b48` | `91437292` | 2026-09-17 21:28Z | capital_structure | 1.1.0 | b484551 |
| model_runs | `48a72d1a` | `91437292` | 2026-09-17 21:28Z | management | 1.1.0 | b484551 |
| model_runs | `63ccd4e9` | `91437292` | 2026-09-17 21:29Z | supply_chain_position | 1.2.0 | b484551 |
| model_runs | `acd5efa1` | `91437292` | 2026-09-17 21:29Z | valuation_assumptions | 1.1.0 | b484551 |
| model_runs | `2afc6705` | `976079bf` | 2026-09-18 08:50Z | final_synthesis | 1.0.0 | 683cb9c |
| model_runs | `6da5644b` | `976079bf` | 2026-09-18 08:58Z | final_synthesis | 1.0.0 | 683cb9c |
| module_runs | `a994e546` | `91437292` | 2026-09-17 20:56Z | company_profile | 1.1.0 | b484551 |
| module_runs | `341568e0` | `91437292` | 2026-09-17 20:56Z | financial_quality | 1.1.0 | b484551 |
| module_runs | `52f44bdc` | `91437292` | 2026-09-17 20:56Z | business_model | 1.1.0 | b484551 |
| module_runs | `833e9cee` | `91437292` | 2026-09-17 21:18Z | company_profile | 1.1.0 | b484551 |
| module_runs | `ce84b717` | `91437292` | 2026-09-17 21:18Z | business_model | 1.1.0 | b484551 |
| module_runs | `45d3abfb` | `91437292` | 2026-09-17 21:18Z | financial_quality | 1.1.0 | b484551 |
| module_runs | `8c0cd221` | `91437292` | 2026-09-17 21:18Z | commodity_exposure | 1.1.0 | b484551 |
| module_runs | `f4bf9624` | `91437292` | 2026-09-17 21:18Z | industry_position | 1.1.0 | b484551 |
| module_runs | `69e701b1` | `91437292` | 2026-09-17 21:18Z | capital_structure | 1.1.0 | b484551 |
| module_runs | `31e7effc` | `91437292` | 2026-09-17 21:18Z | management | 1.1.0 | b484551 |
| module_runs | `6fe13280` | `91437292` | 2026-09-17 21:19Z | valuation_assumptions | 1.1.0 | b484551 |
| module_runs | `12b45fb8` | `91437292` | 2026-09-17 21:19Z | supply_chain_position | 1.2.0 | b484551 |
| module_runs | `8719da52` | `91437292` | 2026-09-17 21:19Z | project_pipeline | 1.1.0 | b484551 |
| module_runs | `d4233e06` | `91437292` | 2026-09-17 21:19Z | competitive_landscape | 1.1.0 | b484551 |
| module_runs | `b973d304` | `91437292` | 2026-09-17 21:20Z | catalysts | 1.1.0 | b484551 |
| module_runs | `5509efe2` | `91437292` | 2026-09-17 21:20Z | risks | 1.1.0 | b484551 |
| module_runs | `36698445` | `91437292` | 2026-09-17 21:21Z | bear_case | 1.1.0 | b484551 |
| module_runs | `64dc6c09` | `91437292` | 2026-09-17 21:27Z | company_profile | 1.1.0 | b484551 |
| module_runs | `d8a13a48` | `91437292` | 2026-09-17 21:28Z | business_model | 1.1.0 | b484551 |
| module_runs | `eb247605` | `91437292` | 2026-09-17 21:28Z | financial_quality | 1.1.0 | b484551 |
| module_runs | `dc69cd37` | `91437292` | 2026-09-17 21:28Z | commodity_exposure | 1.1.0 | b484551 |
| module_runs | `dda4082f` | `91437292` | 2026-09-17 21:28Z | industry_position | 1.1.0 | b484551 |
| module_runs | `4b53773b` | `91437292` | 2026-09-17 21:28Z | capital_structure | 1.1.0 | b484551 |
| module_runs | `65c17cae` | `91437292` | 2026-09-17 21:28Z | management | 1.1.0 | b484551 |
| module_runs | `f197d390` | `91437292` | 2026-09-17 21:28Z | supply_chain_position | 1.2.0 | b484551 |
| module_runs | `5d7c02aa` | `91437292` | 2026-09-17 21:28Z | valuation_assumptions | 1.1.0 | b484551 |
