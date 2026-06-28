#include <string>
#include <sstream>
#include <iostream>
#include <unordered_map>
#include <algorithm>

using namespace std;

class UrlParser {
public:
    struct ParsedUrl {
        string scheme;
        string host;
        string path;
        string query;
        unordered_map<string, string> queryParams;
        bool valid = false;
    };

    static ParsedUrl parse(const string& url) {
        ParsedUrl result;
        
        // Find scheme
        size_t schemeEnd = url.find("://");
        if (schemeEnd == string::npos) {
            return result; // Invalid URL
        }
        
        result.scheme = url.substr(0, schemeEnd);
        size_t start = schemeEnd + 3;
        
        // Find host (everything until first '/' or '?')
        size_t hostEnd = url.find_first_of("/?", start);
        if (hostEnd == string::npos) {
            result.host = url.substr(start);
            result.valid = true;
            return result;
        }
        
        result.host = url.substr(start, hostEnd - start);
        
        // Find path and query
        if (url[hostEnd] == '/') {
            size_t queryStart = url.find('?', hostEnd);
            if (queryStart != string::npos) {
                result.path = url.substr(hostEnd, queryStart - hostEnd);
                result.query = url.substr(queryStart + 1);
            } else {
                result.path = url.substr(hostEnd);
            }
        } else if (url[hostEnd] == '?') {
            result.query = url.substr(hostEnd + 1);
        }
        
        // Parse query parameters
        if (!result.query.empty()) {
            parseQueryParams(result.query, result.queryParams);
        }
        
        result.valid = true;
        return result;
    }

private:
    static void parseQueryParams(const string& query, unordered_map<string, string>& params) {
        istringstream ss(query);
        string pair;
        
        while (getline(ss, pair, '&')) {
            size_t eqPos = pair.find('=');
            if (eqPos != string::npos) {
                string key = pair.substr(0, eqPos);
                string value = pair.substr(eqPos + 1);
                
                // URL decode if needed (basic implementation)
                urlDecode(key);
                urlDecode(value);
                
                params[key] = value;
            }
        }
    }
    
    static void urlDecode(string& str) {
        string result;
        result.reserve(str.length());
        
        for (size_t i = 0; i < str.length(); ++i) {
            if (str[i] == '%' && i + 2 < str.length()) {
                // Convert hex to char
                string hex = str.substr(i + 1, 2);
                char ch = static_cast<char>(stoi(hex, nullptr, 16));
                result += ch;
                i += 2;
            } else if (str[i] == '+') {
                result += ' ';
            } else {
                result += str[i];
            }
        }
        
        str = result;
    }
};