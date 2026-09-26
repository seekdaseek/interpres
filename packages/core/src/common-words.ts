/**
 * Common English words, for keeping them OUT of `input.keyterms`.
 *
 * The docs are explicit: "Don't add common English words. Each entry boosts that
 * string, and adding common words at the same weight as your rare terms dilutes
 * the boost." The recogniser already knows these; boosting them spends the
 * 100-term budget on nothing.
 *
 * Roughly the most frequent English words, plus the everyday vocabulary tool
 * names are built from (get, list, check, site, order, link...). Plurals are
 * matched through `isCommonWord`, so "services" is caught by "service".
 */
const WORDS = `
a able about above accept across act action actually add address after again against age ago agree ahead air all allow
almost alone along already also although always am among amount an and animal another answer any anyone anything appear
apply approach are area arm around arrive art as ask at available away back bad bag ball bank base basic be beautiful
because become bed been before begin behind being believe below best better between big bit black blue board body book
both box boy break bring brother brown build building business but buy by call came can car card care carry case catch
cause cell center certain chair chance change character charge check child choice choose church city class clear close
code cold collect color come common company compare complete computer condition consider contain continue control cook
cool copy corner correct cost could count country course cover create cross cup current cut dark data date daughter day
dead deal dear death decide deep default describe design detail develop did die difference different difficult dinner
direct direction do doctor does dog door double down draw dream dress drink drive drop during each early earth east easy
eat edge effect eight either else end enough enter entire even evening event ever every everyone everything example
exist expect experience explain eye face fact fall family far fast father fear feel feet few field figure file fill
final find fine finish fire first fish five floor fly follow food foot for force forget form four free friend from
front full fun game garden gave general get girl give glass go good got government great green ground group grow guess
had hair half hand happen happy hard has have he head health hear heart heat heavy help her here high him himself his
history hit hold home hope horse hot hotel hour house how however huge human hundred idea if image important in include
increase indeed industry info information inside instead interest into is issue it item its itself job join just keep
key kid kill kind king know land language large last late later laugh law lay lead learn least leave left leg less let
letter level lie life light like line link list listen little live local long look lose lot love low machine made main
major make man manage many map mark market matter may maybe me mean measure media meet member memory men message
method middle might mile mind minute miss model modern moment money month more morning most mother move much music must
my myself name nation natural near need never new news next nice night no none nor north not note nothing notice now
number of off offer office often oh old on once one only open option or order other our out outside over own page paper
parent part party pass past path pay people per perform perhaps period person phone pick picture piece place plan plant
play please point policy poor popular position possible power prepare present press pretty price probably problem
process produce product program provide public pull purpose push put question quick quickly quite race rain raise
range rate rather reach read ready real reason receive recent record red reduce region remain remember remove report
represent request require rest result return rich right rise road rock role room rule run safe said same save saw say
school science sea search season seat second section see seem sell send sense serve service set seven several shall
share she short should show side sign simple simply since sing single sister sit site six size skill small smile so
social some someone something sometimes son song soon sort sound source south space speak special specific spend
spring staff stage stand standard star start state stay step still stock stop store story street strong student study
subject success such suggest summer sun support sure system table take talk task team teach teacher tell ten term test
than thank that the their them then there these they thing think third this those though thought thousand three through
throw time to today together too top total toward town trade traffic train travel tree trip true truth try turn two
type under understand unit until up upon us use user usual value various very view visit voice wait walk wall want war
watch water way we wear week well were west what whatever when where whether which while white who whole whom whose
why wide wife will win window wish with within without woman women wonder word work world worry would write wrong
yard yeah year yes yet you young your yourself
account accounts active add admin agent alert all api app apply archive args array asset assets auth author backup basics
batch bill billing body bool branch browse buffer build cache calendar cancel catalog category channel chat child
client cloud comment config connect connection contact content context contract convert count create credit custom customer
dashboard database dataset debug delete deploy description details device dict directory disable doc docs document
domain done download draft edit email enable endpoint entry error errors estimate export extract feature feed fetch
field fields filter find flag folder format forward get guide handle hash header history host hub id ids import index
input insert install instance integration invoice issue items keyword label latest launch layer lookup match max media
merge meta metadata min mode module monitor name names network node note notes notify object open operation output
owner package page params parse patch payment pending permission ping plan platform plugin post preview profile
project prompt property query queue quote range rank read reads record records refresh register release reply repo
resource response results review role route row rows run save schedule schema scope score script send server
session setting settings setup show sign snapshot sort source spec start stat stats status stop store stream string
submit summary sync tag tags target template text thread ticket timeline title token tool tools topic track update
upload url usage user users validate value values version video view watch web webhook widget word workflow write
`;

export const COMMON_WORDS: ReadonlySet<string> = new Set(WORDS.split(/\s+/).filter(Boolean));

/**
 * A word, its plural, or a simple inflection in the list: "services" counts as
 * "service", "signed" as "sign", "created" as "create", "listing" as "list".
 */
export function isCommonWord(word: string): boolean {
  const w = word.toLowerCase();
  const has = (x: string) => x.length > 1 && COMMON_WORDS.has(x);
  if (has(w)) return true;
  if (w.endsWith('ies') && has(`${w.slice(0, -3)}y`)) return true;
  if (w.endsWith('es') && has(w.slice(0, -2))) return true;
  if (w.endsWith('s') && has(w.slice(0, -1))) return true;
  if (w.endsWith('ed') && (has(w.slice(0, -2)) || has(w.slice(0, -1)))) return true;
  if (w.endsWith('ing') && (has(w.slice(0, -3)) || has(`${w.slice(0, -3)}e`))) return true;
  return false;
}
