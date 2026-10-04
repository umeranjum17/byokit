#include "chat.h"
#include "json-schema-to-grammar.h"
#include "llama-grammar.h"
#include <fstream>
#include <iostream>
#include <sstream>
std::string read(const char *p) { std::ifstream f(p); std::stringstream s; s << f.rdbuf(); return s.str(); }
bool accepts(const std::string &grammar, const std::string &text) {
 auto *g = llama_grammar_init_impl(nullptr, grammar.c_str(), "root", false, nullptr, 0, nullptr, 0);
 if (!g) throw std::runtime_error("grammar parse failed");
 for (unsigned char c : text) { if (c > 127) throw std::runtime_error("ASCII fixture only"); llama_grammar_accept(g,c); }
 bool complete = false;
 for (const auto &s : llama_grammar_get_stacks(g)) if (s.empty()) complete = true;
 llama_grammar_free_impl(g); return complete;
}
int main(int argc, char **argv) {
 if (argc != 4) return 2;
 auto req = json::parse(read(argv[1])).at("options");
 auto tmpl = common_chat_templates_init(nullptr, read(argv[2]));
 common_chat_templates_inputs in;
 in.messages = common_chat_msgs_parse_oaicompat(req.at("messages"));
 in.json_schema = req.at("response_format").at("json_schema").at("schema").dump();
 in.use_jinja = true; in.enable_thinking = false;
 auto j = common_chat_templates_apply(tmpl.get(), in);
 in.use_jinja = false;
 auto legacy = common_chat_templates_apply(tmpl.get(), in);
 auto raw = json::parse(read(argv[3])).at("text").get<std::string>();
 json checks = {{"exact_native_raw_accepted_by_jinja",accepts(j.grammar,raw)}};
 auto body = json::parse(raw.substr(raw.find('{')));
 const bool lines_first = req.at("response_format").at("json_schema").at("schema").at("oneOf")[0].at("properties").begin().key() == "lines";
 auto trial = [&](const std::string &name, bool enough, json lines) {
   const auto value = lines_first ? json({{"lines",lines},{"enough",enough}}) : json({{"enough",enough},{"lines",lines}});
   checks[name] = accepts(j.grammar,j.generation_prompt + value.dump());
 };
 auto lines = body.at("lines");
 trial("false_four",false,lines);
 trial("true4",true,lines); lines.erase(lines.end()-1); trial("true3",true,lines);
 trial("false_empty",false,json::array()); trial("false_one",false,{"One proposed line."});
 trial("true2",true,{"First line.","Second line."});
 trial("true5",true,{"One.","Two.","Three.","Four.","Five."});
 trial("empty_line",true,{"", "Two.","Three."});
 trial("line100",true,{std::string(100,'a'),"Two.","Three."});
 trial("line101",true,{std::string(101,'a'),"Two.","Three."});
 trial("newline",true,{"One.\nTwo.","Three.","Four."});
 trial("escaped_quote",true,{"One \"quote\".","Two.","Three."});
 trial("escaped_backslash",true,{"One \\ slash.","Two.","Three."});
 std::cout << json({{"checks",checks},{"jinja", {{"prompt",j.prompt},{"grammar",j.grammar},{"generation_prompt",j.generation_prompt},{"chat_parser",j.parser},{"chat_format",j.format},{"grammar_lazy",j.grammar_lazy}}}, {"legacy",{{"prompt",legacy.prompt},{"grammar",legacy.grammar}}}, {"direct_grammar",json_schema_to_grammar(json::parse(in.json_schema))}}).dump(2) << '\n';
}
